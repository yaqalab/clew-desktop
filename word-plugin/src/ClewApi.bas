Attribute VB_Name = "ClewApi"
' Talks to Clew Desktop's local API: plain HTTP on 127.0.0.1 (see src/local-api.js).
'
' The functions here show nothing to the user and return a short status string, so they can be
' called from the ribbon (Ribbon.bas) or from a test through Application.Run.
'
' The token is kept in the registry, under HKCU\Software\VB and VBA Program Settings\yaqatw\Clew.
' Clew writes it there itself when it installs this template; pairing (ClewPair) is the way
' back when it is lost. "Port" there overrides the port.
'
' No VBScript components (VBScript.RegExp, ScriptControl, Scriptlet.TypeLib): Windows is
' retiring VBScript. WinHttp is part of Windows itself.
Option Explicit

Private Const APP_KEY As String = "yaqatw"
Private Const SECTION As String = "Clew"
Private Const DEFAULT_PORT As String = "47830"
Private Const CLIENT_NAME As String = "Yaqatw for Word"
' Clew waits two minutes for the user's answer; a little longer here.
Private Const PAIR_WAIT_SECONDS As Long = 130

' Word is in front, Clew is not: Windows lets Clew bring its question forward only if the
' program in front allows it.
Private Declare PtrSafe Function AllowSetForegroundWindow Lib "user32" (ByVal dwProcessId As Long) As Long

Private Function BaseUrl() As String
    BaseUrl = "http://127.0.0.1:" & GetSetting(APP_KEY, SECTION, "Port", DEFAULT_PORT)
End Function

Private Function Token() As String
    Token = GetSetting(APP_KEY, SECTION, "Token", "")
End Function

' One request. Returns the response body; status is 0 when Clew could not be reached.
' With `pump`, Word's messages are handled while waiting (DoEvents), so Word stays responsive
' through a long wait (Clew asking the user). Without it Word waits still: DoEvents also hands
' Word its background work (layout, proofing), which in a large document took over a second per
' request, charged to the bridge's quick exchanges (Bridge.bas).
Private Function HttpCall(ByVal method As String, ByVal path As String, ByRef status As Long, _
                      Optional ByVal body As String = "", Optional ByVal waitSeconds As Long = 5, _
                      Optional ByVal pump As Boolean = True) As String
    Dim http As Object
    Dim started As Single
    status = 0
    On Error GoTo Failed
    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.SetProxy 1 ' direct: never through a proxy
    http.SetTimeouts 2000, 2000, 5000, waitSeconds * 1000
    http.Open method, BaseUrl() & path, True
    If Len(Token()) > 0 Then http.SetRequestHeader "Authorization", "Bearer " & Token()
    If Len(body) > 0 Then
        ' UTF-8 on the wire: WinHttp converts the string with the charset named here.
        http.SetRequestHeader "Content-Type", "application/json; charset=utf-8"
        http.Send body
    Else
        http.Send
    End If
    started = Timer
    Do Until http.WaitForResponse(0.1)
        If pump Then DoEvents
        ' Timer wraps at midnight.
        If Timer < started Then started = started - 86400
        If Timer - started > waitSeconds + 5 Then Exit Function
    Loop
    status = http.status
    HttpCall = http.ResponseText
    Exit Function
Failed:
    status = 0
End Function

' "ok" when Clew Desktop answers, "not-running" when nothing does, "unexpected" when something
' else holds the port.
Public Function ClewHello() As String
    Dim status As Long
    Dim body As String
    body = HttpCall("GET", "/v1/hello", status)
    If status = 0 Then
        ClewHello = "not-running"
    ElseIf status = 200 And JsonString(body, "app") = "clew-desktop" Then
        ClewHello = "ok"
    Else
        ClewHello = "unexpected"
    End If
End Function

' "paired:<name>" when the stored token is still good, "unpaired", or "not-running".
Public Function ClewCheck() As String
    Dim status As Long
    Dim body As String
    If Len(Token()) = 0 Then
        ClewCheck = "unpaired"
        Exit Function
    End If
    body = HttpCall("GET", "/v1/me", status)
    Select Case status
        Case 0: ClewCheck = "not-running"
        Case 200: ClewCheck = "paired:" & JsonString(body, "name")
        Case 401: ClewCheck = "unpaired"
        Case Else: ClewCheck = "error:" & status
    End Select
End Function

' Asks Clew to pair; Clew asks the user. "paired", "refused", "timeout", "busy", "not-running"
' or "error:<code>".
Public Function ClewPair() As String
    Dim status As Long
    Dim body As String
    Dim newToken As String
    ' A token Clew no longer knows would be sent along; it is not needed to pair.
    ClewForget
    ClewAllowForeground
    body = HttpCall("POST", "/v1/pair", status, "{""name"":" & JsonStr(CLIENT_NAME) & "}", PAIR_WAIT_SECONDS)
    If status = 0 Then
        ClewPair = "not-running"
    ElseIf status = 200 Then
        newToken = JsonString(body, "token")
        If Len(newToken) = 0 Then
            ClewPair = "error:no-token"
        Else
            SaveSetting APP_KEY, SECTION, "Token", newToken
            ClewPair = "paired"
        End If
    Else
        ClewPair = JsonString(body, "error")
        If Len(ClewPair) = 0 Then ClewPair = "error:" & status
    End If
End Function

' Forgets the token (Clew keeps its side until the user removes it there).
Public Sub ClewForget()
    On Error Resume Next
    DeleteSetting APP_KEY, SECTION, "Token"
End Sub

' Lets Clew Desktop bring its window or question to the front: Word is in front, and Windows
' only lets a program behind come forward if the one in front allows it.
Public Sub ClewAllowForeground()
    Dim status As Long
    Dim pid As String
    pid = JsonDigits(HttpCall("GET", "/v1/hello", status), "pid")
    If status = 200 And Len(pid) > 0 Then AllowSetForegroundWindow CLng(pid)
End Sub

' A POST with a JSON body, with this template's token. Returns the body; status 0 when Clew
' could not be reached.
Public Function ClewPost(ByVal path As String, ByVal body As String, ByRef status As Long, _
                         Optional ByVal waitSeconds As Long = 5, Optional ByVal pump As Boolean = True) As String
    ClewPost = HttpCall("POST", path, status, body, waitSeconds, pump)
End Function

' Starts a POST with a JSON body and returns the request without waiting for it (Nothing when it
' could not start). The caller waits with ClewDone, doing other work meanwhile (Bridge.BridgeAction
' carries out Word operations while yaqatw answers).
Public Function ClewStart(ByVal path As String, ByVal body As String, ByVal waitSeconds As Long) As Object
    Dim http As Object
    On Error GoTo Failed
    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.SetProxy 1
    http.SetTimeouts 2000, 2000, 5000, waitSeconds * 1000
    http.Open "POST", BaseUrl() & path, True
    If Len(Token()) > 0 Then http.SetRequestHeader "Authorization", "Bearer " & Token()
    http.SetRequestHeader "Content-Type", "application/json; charset=utf-8"
    http.Send body
    Set ClewStart = http
    Exit Function
Failed:
    Set ClewStart = Nothing
End Function

' Whether a started request has its answer (waiting up to `seconds`); `failed` when it ended
' without one (Clew gone).
Public Function ClewDone(ByVal http As Object, ByVal seconds As Single, ByRef failed As Boolean) As Boolean
    On Error GoTo Failed
    ClewDone = http.WaitForResponse(seconds)
    Exit Function
Failed:
    failed = True
    ClewDone = True
End Function
