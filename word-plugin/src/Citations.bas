Attribute VB_Name = "Citations"
' What yaqatw inserts in a writing document: quotes, notes, figures and tables, as yaqatw's
' WordDocumentHost does (yaqatw: src/host/WordDocumentHost.ts). A linked one sits in a content
' control tagged yaqat-cite-tag, whose id yaqatw keeps in its citations part to refresh it later.
Option Explicit

Private Const ERR_CITE As Long = vbObjectError + 720
Private Const CITE_TAG As String = "yaqat-cite-tag"

' A content control's id as the web add-in gives it: w:id as the file has it, a signed 32-bit
' number. VBA gives the same number unsigned. Either form comes back as the signed one, so ids
' saved by the web add-in and by this template are the same.
Public Function SignedId(ByVal id As String) As String
    Dim n As Double
    n = CDbl(id)
    If n >= 2147483648# Then n = n - 4294967296#
    SignedId = Format$(n, "0")
End Function

' The citation control with this id (either form), or Nothing.
Private Function FindCite(ByVal d As Document, ByVal id As String) As ContentControl
    Dim cc As ContentControl
    Dim want As String
    want = SignedId(id)
    For Each cc In d.SelectContentControlsByTag(CITE_TAG)
        If SignedId(cc.ID) = want Then
            Set FindCite = cc
            Exit Function
        End If
    Next cc
End Function

Private Function CiteControl(ByVal d As Document, ByVal id As String) As ContentControl
    Set CiteControl = FindCite(d, id)
    If CiteControl Is Nothing Then Err.Raise ERR_CITE, "Citations", "This citation is no longer in the document."
End Function

' A new citation control around `where`, the selection by default.
Private Function NewCite(ByVal d As Document, ByVal title As String, Optional ByVal where As Range) As ContentControl
    Dim cc As ContentControl
    If where Is Nothing Then Set where = SelectionOf(d).Range
    Set cc = d.ContentControls.Add(wdContentControlRichText, where)
    cc.Tag = CITE_TAG
    cc.Appearance = wdContentControlBoundingBox
    ' Word refuses titles over its limit; the start of the title is enough.
    On Error Resume Next
    cc.Title = Left$(title, 255)
    If Err.Number <> 0 Then
        Err.Clear
        cc.Title = Left$(title, 64)
    End If
    On Error GoTo 0
    Set NewCite = cc
End Function

Private Function ControlIdJson(ByVal cc As ContentControl) As String
    If cc Is Nothing Then
        ControlIdJson = "{}"
    Else
        ControlIdJson = "{""controlId"":" & JsonStr(SignedId(cc.ID)) & "}"
    End If
End Function

' A quote or a note: its text, in the Quote style for a block quote.
Public Function InsertCitation(ByVal d As Document, ByVal title As String, ByVal text As String, _
                               ByVal block As Boolean) As String
    Dim cc As ContentControl
    Set cc = NewCite(d, title)
    SetCiteText d, cc, text, block
    InsertCitation = ControlIdJson(cc)
End Function

Public Function RefreshCitation(ByVal d As Document, ByVal id As String, ByVal text As String, _
                                ByVal block As Boolean) As String
    SetCiteText d, CiteControl(d, id), text, block
    RefreshCitation = "null"
End Function

Private Sub SetCiteText(ByVal d As Document, ByVal cc As ContentControl, ByVal text As String, _
                        ByVal block As Boolean)
    cc.Range.Text = text
    If block Then cc.Range.Style = d.Styles(wdStyleQuote)
End Sub

' A figure or a table: Word XML (a flat OPC package) in a citation control, or, unlinked, in
' place of the selection with no control around it.
Public Function InsertCitationXml(ByVal d As Document, ByVal title As String, ByVal xml As String, _
                                  ByVal link As Boolean) As String
    Dim cc As ContentControl
    Dim r As Range
    If link Then
        Set cc = NewCite(d, title, BlockAt(d))
        cc.Range.InsertXML xml
        Set r = cc.Range
    Else
        Set r = SelectionOf(d).Range
        r.InsertXML xml
    End If
    FitPictures d, r
    UpdateBodyFields d
    InsertCitationXml = ControlIdJson(cc)
End Function

Public Function RefreshCitationXml(ByVal d As Document, ByVal id As String, ByVal xml As String) As String
    Dim cc As ContentControl
    Set cc = CiteControl(d, id)
    ' InsertXML adds to what is there: the old figure or table goes first.
    cc.Range.Delete
    cc.Range.InsertXML xml
    FitPictures d, cc.Range
    UpdateBodyFields d
    RefreshCitationXml = "null"
End Function

' A figure or a table is a block of paragraphs: it goes in an empty paragraph of its own at the
' selection, which it replaces, so its control holds all of it (in a control inside a line, Word
' puts the paragraphs after the first one outside the control).
Private Function BlockAt(ByVal d As Document) As Range
    Dim r As Range
    Set r = SelectionOf(d).Range
    If r.Start <> r.End Then r.Delete
    r.Collapse wdCollapseStart
    ' Text before the caret: a new paragraph from the caret on.
    If r.Start > r.Paragraphs(1).Range.Start Then
        r.InsertAfter vbCr
        r.Collapse wdCollapseEnd
    End If
    ' Text after the caret: an empty paragraph before it.
    If r.End < r.Paragraphs(1).Range.End - 1 Then
        r.InsertBefore vbCr
        r.Collapse wdCollapseStart
    End If
    Set BlockAt = r.Paragraphs(1).Range
End Function

' Pictures wider than the text column are made to fit it, keeping their proportions, as Word
' does for a picture inserted from a file.
Private Sub FitPictures(ByVal d As Document, ByVal r As Range)
    Dim shp As InlineShape
    Dim usable As Single
    On Error Resume Next
    With r.Sections(1).PageSetup
        usable = .PageWidth - .LeftMargin - .RightMargin - .Gutter
    End With
    If usable <= 0 Then Exit Sub
    For Each shp In r.InlineShapes
        If shp.Width > usable Then
            shp.LockAspectRatio = msoTrue
            shp.Height = shp.Height * usable / shp.Width
            shp.Width = usable
        End If
    Next shp
End Sub

' Caption numbers (SEQ fields) follow the figures' and tables' order at once.
Private Sub UpdateBodyFields(ByVal d As Document)
    On Error Resume Next
    d.Content.Fields.Update
End Sub

' The ids of the document's citation controls, in document order.
Public Function CitationIds(ByVal d As Document) As String
    Dim cc As ContentControl
    Dim ids() As String
    Dim n As Long
    Dim all As ContentControls
    Set all = d.SelectContentControlsByTag(CITE_TAG)
    If all.Count = 0 Then
        CitationIds = "[]"
        Exit Function
    End If
    ReDim ids(0 To all.Count - 1)
    For Each cc In all
        ids(n) = SignedId(cc.ID)
        n = n + 1
    Next cc
    CitationIds = JsonStrArray(ids)
End Function

' Deleting takes the content with the control; unlinking keeps the content. A citation already
' gone is no error, as in the web add-in.
Public Function RemoveCitation(ByVal d As Document, ByVal id As String, ByVal keepContent As Boolean) As String
    Dim cc As ContentControl
    Set cc = FindCite(d, id)
    If Not cc Is Nothing Then cc.Delete Not keepContent
    RemoveCitation = "null"
End Function

Public Function UnlinkAllCitations(ByVal d As Document) As String
    Dim all As ContentControls
    Dim i As Long
    Set all = d.SelectContentControlsByTag(CITE_TAG)
    For i = all.Count To 1 Step -1
        all(i).Delete False
    Next i
    UnlinkAllCitations = "null"
End Function
