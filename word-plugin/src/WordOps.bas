Attribute VB_Name = "WordOps"
' The operations Clew Desktop asks of a document (Bridge.bas), each answering as yaqatw's
' WordDocumentHost does (yaqatw: src/host/WordDocumentHost.ts) so yaqatw sees the same document
' through either. Each returns its result as JSON text; a failure raises an error whose
' description goes back to Clew.
Option Explicit

Private Const ERR_OP As Long = vbObjectError + 700

Public Function WordOp(ByVal d As Document, ByVal name As String, args As Variant) As String
    Select Case name
        ' Custom XML parts: where yaqatw keeps its entities, the same parts as the web add-in.
        Case "readXmlPart": WordOp = JsonStr(ReadXmlPart(d, Arg(args, "ns"), Arg(args, "root"), False))
        Case "ensureXmlPart": WordOp = JsonStr(ReadXmlPart(d, Arg(args, "ns"), Arg(args, "root"), True))
        Case "saveXmlPart": SaveXmlPart d, Arg(args, "ns"), Arg(args, "xml"): WordOp = "null"
        Case "deleteXmlParts": DeleteXmlParts d, Arg(args, "ns"): WordOp = "null"

        ' Text
        Case "getAllText": WordOp = JsonStr(d.Content.Text)
        Case "isEmpty": WordOp = IIf(IsBlank(d.Content.Text), "true", "false")
        Case "getParagraphs": WordOp = JsonStrArray(ParagraphTexts(d))
        Case "getSelectionText": WordOp = JsonStr(SelectionText(d))
        Case "getSelectionParagraphText": WordOp = JsonStr(SelectionParagraphText(d))
        Case "insertTextAtSelection": SelectionOf(d).Range.Text = Arg(args, "text"): WordOp = "null"
        Case "appendText": d.Content.InsertAfter Arg(args, "text"): WordOp = "null"

        ' Highlights (Highlights.bas)
        Case "insertHighlightAtSelection"
            WordOp = InsertHighlightAtSelection(d, OptArg(args, "title"), OptArg(args, "color"), _
                BoolArg(args, "expandToParagraphs"), BoolArg(args, "noOverlap"), OptArg(args, "hid"))
        Case "setHighlightTitle": WordOp = SetHighlightTitle(d, Arg(args, "hid"), Arg(args, "title"))
        Case "paintHighlight"
            WordOp = PaintHighlight(d, Arg(args, "hid"), OptArg(args, "title"), OptArg(args, "color"), BoolArg(args, "remove"))
        Case "removeHighlights": WordOp = RemoveHighlights(d, JsonGet(args, "hids"))
        Case "goToHighlight": WordOp = GoToHighlight(d, Arg(args, "hid"))
        Case "goToControl": WordOp = GoToControl(d, Arg(args, "id"))
        Case "getAllHighlights": WordOp = AllHighlights(d)
        Case "getHighlightParagraphMap": WordOp = HighlightParagraphMap(d)
        Case "currentHighlight": WordOp = CurrentHighlight(d)
        Case "setHighlightsVisible": WordOp = SetHighlightsVisible(d, BoolArg(args, "visible"))

        ' Finding and selecting text (the host page builds the search candidates and scores them)
        Case "findText": WordOp = FindText(d, Arg(args, "text"), NumArg(args, "max", 50), BoolArg(args, "context"))
        Case "selectRange": WordOp = SelectRange(d, NumArg(args, "start", -1), NumArg(args, "end", -1))

        ' Tables and comments
        Case "readMetadataTable": WordOp = MetadataTable(d)
        Case "getComments": WordOp = CommentsOf(d)

        ' The document
        Case "getDocumentTitle": WordOp = JsonStr(DocumentTitle(d))
        Case "getCurrentFilePath": WordOp = IIf(Len(d.Path) > 0, JsonStr(d.FullName), "null")
        Case "getVariable": WordOp = GetVariable(d, Arg(args, "key"))
        Case "setVariable": SetVariable d, Arg(args, "key"), JsonGet(args, "value"): WordOp = "null"

        Case "ping": WordOp = JsonStr("pong")
        Case Else: Err.Raise ERR_OP, "WordOps", name & " is not supported in Word yet."
    End Select
End Function

' A string argument; a missing one is an error.
Private Function Arg(args As Variant, ByVal key As String) As String
    Dim v As Variant
    v = JsonGet(args, key)
    If IsNull(v) Then Err.Raise ERR_OP, "WordOps", "missing argument: " & key
    Arg = CStr(v)
End Function

' A string argument that may be missing ("").
Private Function OptArg(args As Variant, ByVal key As String) As String
    Dim v As Variant
    v = JsonGet(args, key)
    If Not IsNull(v) Then OptArg = CStr(v)
End Function

' A whole-number argument, or `fallback`.
Private Function NumArg(args As Variant, ByVal key As String, ByVal fallback As Long) As Long
    Dim v As Variant
    v = JsonGet(args, key)
    If VarType(v) = vbDouble Then NumArg = CLng(v) Else NumArg = fallback
End Function

' A boolean argument; missing is False.
Private Function BoolArg(args As Variant, ByVal key As String) As Boolean
    Dim v As Variant
    v = JsonGet(args, key)
    If VarType(v) = vbBoolean Then BoolArg = v
End Function

' ----------------------------------------------------------------------------------------------
' Custom XML parts

Private Function ReadXmlPart(ByVal d As Document, ByVal ns As String, ByVal root As String, _
                             ByVal create As Boolean) As String
    Dim parts As CustomXMLParts
    Dim blank As String
    Set parts = d.CustomXMLParts.SelectByNamespace(ns)
    If parts.Count > 0 Then
        ReadXmlPart = parts(1).XML
        Exit Function
    End If
    blank = "<" & root & " xmlns=""" & ns & """></" & root & ">"
    If create Then d.CustomXMLParts.Add blank
    ReadXmlPart = blank
End Function

' Replaces the namespace's parts with one holding `xml`. The new part is added first, so a
' refused XML leaves the old one in place.
Private Sub SaveXmlPart(ByVal d As Document, ByVal ns As String, ByVal xml As String)
    Dim olds As CustomXMLParts
    Dim fresh As CustomXMLPart
    Dim keep() As CustomXMLPart
    Dim kept As Long
    Dim i As Long
    ' The selection is live: it counts the new part once added, so the old ones are taken now.
    Set olds = d.CustomXMLParts.SelectByNamespace(ns)
    kept = olds.Count
    If kept > 0 Then
        ReDim keep(1 To kept)
        For i = 1 To kept
            Set keep(i) = olds(i)
        Next i
    End If
    Set fresh = d.CustomXMLParts.Add(xml)
    If fresh.NamespaceURI <> ns Then
        fresh.Delete
        Err.Raise ERR_OP, "WordOps", "the XML is not in namespace " & ns
    End If
    For i = 1 To kept
        keep(i).Delete
    Next i
End Sub

Private Sub DeleteXmlParts(ByVal d As Document, ByVal ns As String)
    Dim parts As CustomXMLParts
    Dim i As Long
    Set parts = d.CustomXMLParts.SelectByNamespace(ns)
    For i = parts.Count To 1 Step -1
        parts(i).Delete
    Next i
End Sub

' ----------------------------------------------------------------------------------------------
' Text

Private Function IsBlank(ByVal s As String) As Boolean
    Dim i As Long
    For i = 0 To 32
        s = Replace(s, Chr$(i), "")
    Next i
    s = Replace(s, ChrW$(160), "")
    IsBlank = (Len(s) = 0)
End Function

' The text of each paragraph, without its mark; table cells are paragraphs too (their
' end-of-cell marks are dropped).
Private Function ParagraphTexts(ByVal d As Document) As Variant
    Dim text As String
    text = ParagraphMarks(d.Content.Text)
    If Right$(text, 1) = vbCr Then text = Left$(text, Len(text) - 1)
    ParagraphTexts = Split(text, vbCr)
End Function

' Document text with every paragraph boundary as one vbCr: a table cell ends a paragraph (its
' end mark is Chr(7), sometimes after a vbCr); a row's end mark (a second Chr(7)) adds none.
' getParagraphs splits on these, and the highlight paragraph map counts them, so the two agree.
Public Function ParagraphMarks(ByVal s As String) As String
    s = Replace(s, vbCr & Chr$(7), Chr$(7))
    Do While InStr(1, s, Chr$(7) & Chr$(7), vbBinaryCompare) > 0
        s = Replace(s, Chr$(7) & Chr$(7), Chr$(7))
    Loop
    ParagraphMarks = Replace(s, Chr$(7), vbCr)
End Function

' The selected text in this document; with nothing selected, the text of the highlight the
' cursor is in (as the web add-in does); else "".
Private Function SelectionText(ByVal d As Document) As String
    Dim sel As Selection
    ' A document without a window has no selection.
    On Error GoTo NoSelection
    Set sel = d.ActiveWindow.Selection
    On Error GoTo 0
    If Len(Trim$(Replace(sel.Text, vbCr, ""))) > 0 And sel.Type <> wdSelectionIP Then
        SelectionText = sel.Text
        Exit Function
    End If
    On Error Resume Next
    If Not sel.Range.ParentContentControl Is Nothing Then SelectionText = sel.Range.ParentContentControl.Range.Text
    Exit Function
NoSelection:
End Function

' ----------------------------------------------------------------------------------------------
' The document

Private Function DocumentTitle(ByVal d As Document) As String
    On Error Resume Next
    DocumentTitle = CStr(d.BuiltInDocumentProperties(wdPropertyTitle).Value)
End Function

' A document variable, as a JSON string, or null.
Private Function GetVariable(ByVal d As Document, ByVal key As String) As String
    Dim v As Variable
    For Each v In d.Variables
        If v.Name = key Then
            GetVariable = JsonStr(v.Value)
            Exit Function
        End If
    Next v
    GetVariable = "null"
End Function

' Sets a document variable; null (or "") removes it: Word keeps no empty variables.
Private Sub SetVariable(ByVal d As Document, ByVal key As String, ByVal value As Variant)
    Dim v As Variable
    For Each v In d.Variables
        If v.Name = key Then
            If IsNull(value) Then
                v.Delete
            ElseIf Len(CStr(value)) = 0 Then
                v.Delete
            Else
                v.Value = CStr(value)
            End If
            Exit Sub
        End If
    Next v
    If Not IsNull(value) Then
        If Len(CStr(value)) > 0 Then d.Variables.Add key, CStr(value)
    End If
End Sub

' The text of the paragraph the selection starts in, without its mark.
Private Function SelectionParagraphText(ByVal d As Document) As String
    Dim s As String
    s = SelectionOf(d).Range.Paragraphs(1).Range.Text
    s = Replace(s, Chr$(7), "")
    If Right$(s, 1) = vbCr Then s = Left$(s, Len(s) - 1)
    SelectionParagraphText = s
End Function

' ----------------------------------------------------------------------------------------------
' Tables and comments

' A cell's text, trimmed, without its end-of-cell mark.
Private Function CellText(ByVal c As Cell) As String
    Dim s As String
    s = c.Range.Text
    s = Replace(Replace(s, Chr$(13) & Chr$(7), ""), Chr$(7), "")
    CellText = Trim$(Replace(s, vbCr, " "))
End Function

' The document's first table as [{key, value}], as WordDocumentHost.readMetadataTable reads it:
' at least two rows; a "Metadata | Value" header row is skipped; rows without a key are left out.
Private Function MetadataTable(ByVal d As Document) As String
    Dim t As Table
    Dim r As Long
    Dim startRow As Long
    Dim key As String
    Dim value As String
    Dim parts() As String
    Dim n As Long
    MetadataTable = "[]"
    If d.Tables.Count = 0 Then Exit Function
    Set t = d.Tables(1)
    If t.Rows.Count < 2 Then Exit Function
    If t.Rows(1).Cells.Count < 2 Then Exit Function
    startRow = 1
    If LCase$(CellText(t.Cell(1, 1))) = "metadata" And LCase$(CellText(t.Cell(1, 2))) = "value" Then startRow = 2
    ReDim parts(0 To t.Rows.Count)
    On Error Resume Next
    For r = startRow To t.Rows.Count
        key = ""
        value = ""
        key = CellText(t.Cell(r, 1))
        value = CellText(t.Cell(r, 2))
        If Len(key) > 0 Then
            parts(n) = "{""key"":" & JsonStr(key) & ",""value"":" & JsonStr(value) & "}"
            n = n + 1
        End If
    Next r
    On Error GoTo 0
    If n = 0 Then Exit Function
    ReDim Preserve parts(0 To n - 1)
    MetadataTable = "[" & Join(parts, ",") & "]"
End Function

' The document's comments (top-level, replies left out): [{id, authorName, content, text}],
' text being the passage the comment is on.
Private Function CommentsOf(ByVal d As Document) As String
    Dim c As Comment
    Dim parts() As String
    Dim n As Long
    Dim i As Long
    CommentsOf = "[]"
    If d.Comments.Count = 0 Then Exit Function
    ReDim parts(0 To d.Comments.Count - 1)
    For i = 1 To d.Comments.Count
        Set c = d.Comments(i)
        If IsTopLevel(c) Then
            parts(n) = "{""id"":" & JsonStr(CStr(i)) & ",""authorName"":" & JsonStr(c.Author) & _
                ",""content"":" & JsonStr(c.Range.Text) & ",""text"":" & JsonStr(c.Scope.Text) & "}"
            n = n + 1
        End If
    Next i
    If n = 0 Then Exit Function
    ReDim Preserve parts(0 To n - 1)
    CommentsOf = "[" & Join(parts, ",") & "]"
End Function

Private Function IsTopLevel(ByVal c As Comment) As Boolean
    IsTopLevel = True
    On Error Resume Next
    ' Comment.Ancestor (Word 2013+) is the comment a reply answers.
    If Not c.Ancestor Is Nothing Then IsTopLevel = False
End Function

' ----------------------------------------------------------------------------------------------
' Finding text

' Where `text` occurs, case ignored, as Word's own search finds it (at most 255 characters, as
' for Office.js search): [{start, end, paragraphText}], at most `maxHits`. paragraphText is the
' text of the paragraphs the match is in.
Private Function FindText(ByVal d As Document, ByVal text As String, ByVal maxHits As Long, _
                          ByVal withContext As Boolean) As String
    Dim r As Range
    Dim parts() As String
    Dim n As Long
    Dim para As String
    Dim p As Paragraph
    If Len(text) = 0 Or Len(text) > 255 Then
        FindText = "[]"
        Exit Function
    End If
    If maxHits < 1 Then maxHits = 1
    ReDim parts(0 To maxHits - 1)
    Set r = d.Content
    With r.Find
        .ClearFormatting
        ' "^" starts Word's special codes; a literal one is "^^".
        .Text = Replace(text, "^", "^^")
        .Forward = True
        .Wrap = wdFindStop
        .Format = False
        .MatchCase = False
        .MatchWholeWord = False
        .MatchWildcards = False
        .MatchSoundsLike = False
        .MatchAllWordForms = False
    End With
    Do While r.Find.Execute
        para = ""
        For Each p In r.Paragraphs
            para = para & " " & p.Range.Text
        Next p
        para = Trim$(Replace(Replace(para, vbCr, " "), Chr$(7), ""))
        parts(n) = "{""start"":" & r.Start & ",""end"":" & r.End & ",""paragraphText"":" & JsonStr(para)
        If withContext Then parts(n) = parts(n) & MatchContext(d, r)
        parts(n) = parts(n) & "}"
        n = n + 1
        If n >= maxHits Then Exit Do
        r.Collapse wdCollapseEnd
    Loop
    If n = 0 Then
        FindText = "[]"
    Else
        ReDim Preserve parts(0 To n - 1)
        FindText = "[" & Join(parts, ",") & "]"
    End If
End Function

' Selects the document from `start` to `end` (Word positions, from findText) and shows it.
Private Function SelectRange(ByVal d As Document, ByVal startPos As Long, ByVal endPos As Long) As String
    Dim sel As Selection
    If startPos < 0 Or endPos < startPos Or endPos > d.Content.End Then Err.Raise ERR_OP, "WordOps", "no such place in the document"
    Set sel = SelectionOf(d)
    sel.SetRange startPos, endPos
    On Error Resume Next
    d.ActiveWindow.ScrollIntoView sel.Range, True
    SelectRange = "true"
End Function

' For telling duplicate passages apart (yaqatw: src/service/highlightAnchor.ts): where the match
' is in the document text, the 24 characters on each side, and whether a highlight already
' holds it. As JSON fields to append to the match.
Private Function MatchContext(ByVal d As Document, ByVal r As Range) As String
    Const CONTEXT_CHARS As Long = 24
    Dim before As String
    Dim after As String
    Dim stopAt As Long
    On Error Resume Next
    before = d.Range(d.Content.Start, r.Start).Text
    stopAt = r.End + 4 * CONTEXT_CHARS
    If stopAt > d.Content.End Then stopAt = d.Content.End
    after = d.Range(r.End, stopAt).Text
    On Error GoTo 0
    MatchContext = ",""offset"":" & Len(before) & ",""prefix"":" & JsonStr(Right$(before, CONTEXT_CHARS)) & _
        ",""suffix"":" & JsonStr(Left$(after, CONTEXT_CHARS)) & ",""inHighlight"":" & IIf(HighlightAt(r) Is Nothing, "false", "true")
End Function
