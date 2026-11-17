Attribute VB_Name = "Bridge"
' Sessions with Clew Desktop: a Clew window working on a Word document (src/word-bridge.js).
'
' Clew cannot call into Word, so Word asks for work. While a session is open a tick runs once a
' second (Application.OnTime: no macro running all the time, Word stays free between ticks).
' A tick asks Clew for an operation without waiting; when one comes, it is carried out
' (WordOps.bas), its result goes back with the next ask, and that ask waits a quarter of a second
' for more, so a burst of operations runs back to back. These exchanges do not let Word do its
' background work while they wait (it made them slow in large documents): the waits are short.
' A document that has been closed ends its session. With no session open, nothing runs.
Option Explicit

Private ids As Collection      ' session ids, in opening order
Private docs As Collection     ' session id -> Document
Private scheduled As Boolean
Private inTick As Boolean
Private failures As Long       ' ticks in a row that could not reach Clew
Private events As AppEvents    ' Word's events, once a session is open
Private lastHid As Collection      ' session id -> last highlight id sent ("" for none)
Private pendingHid As Collection   ' session id -> highlight id still to send
Private flushScheduled As Boolean

Private Const TICK_MACRO As String = "BridgeTick"
' Ticks in a row without Clew before the sessions are given up (Clew quit: they are gone there).
Private Const MAX_FAILURES As Long = 10
' How long an ask waits for the next operation of a burst.
Private Const BURST_WAIT_MS As Long = 250

Private Sub EnsureCollections()
    If ids Is Nothing Then Set ids = New Collection
    If docs Is Nothing Then Set docs = New Collection
End Sub

' The session of this document, or "".
Private Function SessionOf(ByVal d As Document) As String
    Dim i As Long
    EnsureCollections
    On Error Resume Next
    For i = 1 To ids.Count
        If docs(ids(i)) Is d Then
            SessionOf = ids(i)
            Exit Function
        End If
    Next i
End Function

Private Sub Forget(ByVal id As String)
    Dim i As Long
    On Error Resume Next
    docs.Remove id
    For i = ids.Count To 1 Step -1
        If ids(i) = id Then ids.Remove i
    Next i
    If Not lastHid Is Nothing Then lastHid.Remove id
    If Not pendingHid Is Nothing Then pendingHid.Remove id
End Sub

Public Function BridgeSessionCount() As Long
    EnsureCollections
    BridgeSessionCount = ids.Count
End Function

' Opens a Clew window on the active document, or shows its window again. "ok:<session>",
' "no-document", "not-running", "unpaired" or "error:<code>".
Public Function BridgeOpen() As String
    Dim d As Document
    Dim known As String
    Dim body As String
    Dim answer As String
    Dim status As Long
    Dim id As String
    EnsureCollections
    If Documents.Count = 0 Then
        BridgeOpen = "no-document"
        Exit Function
    End If
    Set d = ActiveDocument
    known = SessionOf(d)
    body = "{""title"":" & JsonStr(d.Name) & ",""path"":" & JsonStr(d.FullName)
    If Len(known) > 0 Then body = body & ",""session"":" & JsonStr(known)
    body = body & "}"
    ClewAllowForeground
    answer = ClewPost("/v1/word/open", body, status)
    Select Case status
        Case 0
            BridgeOpen = "not-running"
            Exit Function
        Case 401
            BridgeOpen = "unpaired"
            Exit Function
        Case 200
        Case Else
            BridgeOpen = "error:" & status
            Exit Function
    End Select
    id = JsonString(answer, "session")
    If Len(id) = 0 Then
        BridgeOpen = "error:no-session"
        Exit Function
    End If
    If id <> known Then
        If Len(known) > 0 Then Forget known
        ids.Add id
        docs.Add d, id
    End If
    failures = 0
    If events Is Nothing Then
        Set events = New AppEvents
        Set events.App = Application
    End If
    Schedule
    BridgeOpen = "ok:" & id
End Function

Private Sub Schedule()
    If scheduled Then Exit Sub
    scheduled = True
    Application.OnTime When:=Now + TimeSerial(0, 0, 1), Name:=TICK_MACRO
End Sub

' The tick (Application.OnTime). Public so OnTime can find it.
Public Sub BridgeTick()
    Dim i As Long
    Dim list() As String
    Dim reached As Boolean
    scheduled = False
    EnsureCollections
    If inTick Then
        Schedule
        Exit Sub
    End If
    inTick = True
    On Error GoTo Done
    If ids.Count > 0 Then
        ReDim list(1 To ids.Count)
        For i = 1 To ids.Count
            list(i) = ids(i)
        Next i
        reached = True
        For i = 1 To UBound(list)
            If Not Pump(list(i)) Then reached = False
        Next i
        If reached Then failures = 0 Else failures = failures + 1
        If failures >= MAX_FAILURES Then
            Set ids = New Collection
            Set docs = New Collection
            failures = 0
        End If
    End If
Done:
    inTick = False
    If ids.Count > 0 Then Schedule
End Sub

' Works for one session until Clew has nothing more. False when Clew could not be reached.
Private Function Pump(ByVal id As String) As Boolean
    Dim d As Document
    Dim result As String
    Dim body As String
    Dim answer As String
    Dim status As Long
    Dim msg As Variant
    Dim op As Variant
    Dim waitMs As Long

    Set d = Nothing
    On Error Resume Next
    Set d = docs(id)
    ' A closed document: its object no longer answers.
    If Len(d.FullName) = 0 Then Set d = Nothing
    On Error GoTo 0
    If d Is Nothing Then
        ClewPost "/v1/word/close", "{""session"":" & JsonStr(id) & "}", status, 5, False
        Forget id
        Pump = True
        Exit Function
    End If

    waitMs = 0
    Do
        body = "{""session"":" & JsonStr(id) & ",""waitMs"":" & waitMs
        If Len(result) > 0 Then body = body & ",""result"":" & result
        body = body & "}"
        answer = ClewPost("/v1/word/next", body, status, 5, False)
        If status = 0 Then Exit Function
        If status <> 200 Then
            Pump = True
            Exit Function
        End If
        Pump = True
        msg = Empty
        On Error Resume Next
        Set msg = JsonParse(answer)
        On Error GoTo 0
        If Not IsObject(msg) Then Exit Function
        If JsonGet(msg, "closed", False) = True Then
            Forget id
            Exit Function
        End If
        If Not JsonHas(msg, "op") Then Exit Function
        If Not IsObject(JsonGet(msg, "op")) Then Exit Function
        Set op = JsonGet(msg, "op")
        result = RunOp(d, op)
        ' More may follow at once (a yaqatw action is several operations): wait for it a little.
        ' Word waits still meanwhile (no DoEvents, see ClewApi.HttpCall), so only briefly.
        waitMs = BURST_WAIT_MS
    Loop
End Function

' Carries out one operation; its result as Clew wants it back.
Private Function RunOp(ByVal d As Document, op As Variant) As String
    Dim opId As String
    Dim name As String
    Dim args As Variant
    Dim value As String
    opId = CStr(JsonGet(op, "id", ""))
    name = CStr(JsonGet(op, "op", ""))
    If JsonHas(op, "args") Then
        If IsObject(JsonGet(op, "args")) Then Set args = JsonGet(op, "args") Else Set args = New Collection
    Else
        Set args = New Collection
    End If
    Dim undoOpen As Boolean
    Dim message As String
    ' An edit is one step in Word's undo list, named Yaqatw, however many changes it makes.
    If IsEdit(name) Then
        On Error Resume Next
        Application.UndoRecord.StartCustomRecord "Yaqatw"
        undoOpen = (Err.Number = 0)
        Err.Clear
    End If
    On Error GoTo Failed
    value = WordOp(d, name, args)
    If undoOpen Then Application.UndoRecord.EndCustomRecord
    RunOp = "{""id"":" & JsonStr(opId) & ",""ok"":true,""value"":" & value & "}"
    Exit Function
Failed:
    message = Err.Description
    On Error Resume Next
    If undoOpen Then Application.UndoRecord.EndCustomRecord
    RunOp = "{""id"":" & JsonStr(opId) & ",""ok"":false,""error"":" & JsonStr(message) & "}"
End Function

Private Function IsEdit(ByVal name As String) As Boolean
    Select Case name
        Case "insertHighlightAtSelection", "paintHighlight", "removeHighlights", "setHighlightTitle", _
             "setHighlightsVisible", "insertTextAtSelection", "appendText"
            IsEdit = True
    End Select
End Function

' ----------------------------------------------------------------------------------------------
' Events from Word (AppEvents.cls): the highlight under the cursor. Noted at once, sent from a
' macro run right after (OnTime), never from inside Word's event: no request while Word is in
' the middle of something.


Public Sub BridgeSelectionChanged(ByVal sel As Selection)
    Dim id As String
    Dim cc As ContentControl
    Dim hid As String
    On Error GoTo Done
    EnsureCollections
    If ids.Count = 0 Then Exit Sub
    id = SessionOf(sel.Document)
    If Len(id) = 0 Then Exit Sub
    Set cc = HighlightAt(sel.Range)
    If Not cc Is Nothing Then hid = HighlightIdOf(cc)
    If lastHid Is Nothing Then Set lastHid = New Collection
    If pendingHid Is Nothing Then Set pendingHid = New Collection
    If KeyValue(lastHid, id) = hid And Not HasKey(pendingHid, id) Then Exit Sub
    SetKey pendingHid, id, hid
    If Not flushScheduled Then
        flushScheduled = True
        Application.OnTime When:=Now, Name:="BridgeFlushEvents"
    End If
Done:
End Sub

' Sends the noted selection changes (Application.OnTime). Public so OnTime can find it.
Public Sub BridgeFlushEvents()
    Dim i As Long
    Dim id As String
    Dim hid As String
    Dim status As Long
    Dim payload As String
    flushScheduled = False
    If pendingHid Is Nothing Then Exit Sub
    EnsureCollections
    For i = 1 To ids.Count
        id = ids(i)
        If HasKey(pendingHid, id) Then
            hid = KeyValue(pendingHid, id)
            pendingHid.Remove id
            ' Back where it was before the flush: nothing to say.
            If KeyValue(lastHid, id) <> hid Then
                If Len(hid) > 0 Then payload = "{""hid"":" & JsonStr(hid) & "}" Else payload = "{""hid"":null}"
                ClewPost "/v1/word/event", "{""session"":" & JsonStr(id) & ",""event"":""selection"",""payload"":" & payload & "}", status, 2, False
                SetKey lastHid, id, hid
            End If
        End If
    Next i
End Sub

Private Function HasKey(c As Collection, ByVal key As String) As Boolean
    Dim v As Variant
    If c Is Nothing Then Exit Function
    On Error GoTo No
    v = c(key)
    HasKey = True
No:
End Function

Private Function KeyValue(c As Collection, ByVal key As String) As String
    If HasKey(c, key) Then KeyValue = c(key)
End Function

Private Sub SetKey(c As Collection, ByVal key As String, ByVal value As String)
    If HasKey(c, key) Then c.Remove key
    c.Add value, key
End Sub
