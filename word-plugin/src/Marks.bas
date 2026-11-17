Attribute VB_Name = "Marks"
' Marks in the document, in the same form as the yaqatw web add-in writes them
' (yaqatw: src/host/WordDocumentHost.ts, src/service/highlightTag.ts): a rich-text content
' control around the text, tag "yaqatw:id=<uuid>", shown as a blue bounding box.
Option Explicit

Private Type GUID_T
    Data1 As Long
    Data2 As Integer
    Data3 As Integer
    Data4(0 To 7) As Byte
End Type

Private Declare PtrSafe Function CoCreateGuid Lib "ole32" (ByRef id As GUID_T) As Long

' A random UUID, lower case, as crypto.randomUUID() gives it.
Public Function NewUuid() As String
    Dim g As GUID_T
    Dim s As String
    Dim i As Long
    If CoCreateGuid(g) <> 0 Then Err.Raise vbObjectError + 1, "Marks.NewUuid", "CoCreateGuid failed"
    s = Hex8(g.Data1) & "-" & Hex4(g.Data2) & "-" & Hex4(g.Data3) & "-"
    For i = 0 To 7
        If i = 2 Then s = s & "-"
        s = s & Right$("0" & Hex$(g.Data4(i)), 2)
    Next i
    NewUuid = LCase$(s)
End Function

Private Function Hex8(ByVal v As Long) As String
    Hex8 = Right$("0000000" & Hex$(v), 8)
End Function

Private Function Hex4(ByVal v As Integer) As String
    Hex4 = Right$("000" & Hex$(v), 4)
End Function

' Puts a mark around the selection. "ok:<id>", "no-selection", "no-document" or
' "error:<message>". The title is a Variant for Application.Run (see ClewApi.bas).
' All or nothing: a mark that could not be finished is taken away again, its text kept.
Public Function InsertMark(ByVal title As Variant) As String
    Dim cc As ContentControl
    Dim id As String
    Dim label As String
    If Documents.Count = 0 Then
        InsertMark = "no-document"
        Exit Function
    End If
    If Selection.Type <> wdSelectionNormal Or Len(Selection.Range.Text) = 0 Then
        InsertMark = "no-selection"
        Exit Function
    End If
    On Error GoTo Failed
    label = CStr(title)
    id = NewUuid()
    Set cc = ActiveDocument.ContentControls.Add(wdContentControlRichText, Selection.Range)
    cc.title = label
    cc.Tag = "yaqatw:id=" & id
    cc.Appearance = wdContentControlBoundingBox
    cc.Color = wdColorBlue
    InsertMark = "ok:" & id
    Exit Function
Failed:
    InsertMark = "error:" & Err.Description
    On Error Resume Next
    If Not cc Is Nothing Then cc.Delete False
End Function
