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
' Asynchronous with a DoEvents loop, so Word stays responsive while Clew asks the user.
Private Function HttpCall(ByVal method As String, ByVal path As String, ByRef status As Long, _
                      Optional ByVal body As String = "", Optional ByVal waitSeconds As Long = 5) As String
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
        http.SetRequestHeader "Content-Type", "application/json"
        http.Send body
    Else
        http.Send
    End If
    started = Timer
    Do Until http.WaitForResponse(0.1)
        DoEvents
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
    Dim pid As String
    ' A token Clew no longer knows would be sent along; it is not needed to pair.
    ClewForget
    body = HttpCall("GET", "/v1/hello", status)
    pid = JsonDigits(body, "pid")
    If status = 200 And Len(pid) > 0 And Len(pid) < 10 Then AllowSetForegroundWindow CLng(pid)
    body = HttpCall("POST", "/v1/pair", status, "{""name"":""" & JsonEscape(CLIENT_NAME) & """}", PAIR_WAIT_SECONDS)
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

' ----------------------------------------------------------------------------------------------
' JSON, just enough for Clew's flat answers: one string field of an object.
' Arguments of public functions are Variants: Application.Run passes them so (from a test, or
' from another template), and a String parameter would refuse them.

Public Function JsonEscape(ByVal value As Variant) As String
    Dim s As String
    Dim i As Long
    Dim c As String
    Dim out As String
    s = CStr(value)
    For i = 1 To Len(s)
        c = Mid$(s, i, 1)
        Select Case AscW(c)
            Case 34: out = out & "\"""
            Case 92: out = out & "\\"
            Case 0 To 31: out = out & "\u" & Right$("000" & Hex$(AscW(c)), 4)
            Case Else: out = out & c
        End Select
    Next i
    JsonEscape = out
End Function

' The string value of "key" in a flat JSON object, or "" when it is absent or not a string.
Public Function JsonString(ByVal jsonText As Variant, ByVal fieldName As Variant) As String
    Dim json As String
    Dim key As String
    Dim p As Long
    Dim c As String
    Dim out As String
    json = CStr(jsonText)
    key = CStr(fieldName)
    p = InStr(1, json, """" & key & """")
    If p = 0 Then Exit Function
    p = p + Len(key) + 2
    Do While p <= Len(json) And Mid$(json, p, 1) Like "[ :" & vbTab & vbCr & vbLf & "]"
        p = p + 1
    Loop
    If Mid$(json, p, 1) <> """" Then Exit Function
    p = p + 1
    Do While p <= Len(json)
        c = Mid$(json, p, 1)
        If c = """" Then
            JsonString = out
            Exit Function
        ElseIf c = "\" Then
            p = p + 1
            c = Mid$(json, p, 1)
            Select Case c
                Case "n": out = out & vbLf
                Case "r": out = out & vbCr
                Case "t": out = out & vbTab
                Case "b": out = out & Chr$(8)
                Case "f": out = out & Chr$(12)
                Case "u"
                    out = out & ChrW$(CLng("&H" & Mid$(json, p + 1, 4)))
                    p = p + 4
                Case Else: out = out & c
            End Select
        Else
            out = out & c
        End If
        p = p + 1
    Loop
End Function

' The digits of a non-negative integer "key" in a flat JSON object, or "" when it is not one.
Public Function JsonDigits(ByVal jsonText As Variant, ByVal fieldName As Variant) As String
    Dim json As String
    Dim p As Long
    Dim out As String
    json = CStr(jsonText)
    p = InStr(1, json, """" & CStr(fieldName) & """")
    If p = 0 Then Exit Function
    p = p + Len(CStr(fieldName)) + 2
    Do While p <= Len(json) And Mid$(json, p, 1) Like "[ :" & vbTab & vbCr & vbLf & "]"
        p = p + 1
    Loop
    Do While p <= Len(json) And Mid$(json, p, 1) Like "[0-9]"
        out = out & Mid$(json, p, 1)
        p = p + 1
    Loop
    JsonDigits = out
End Function
