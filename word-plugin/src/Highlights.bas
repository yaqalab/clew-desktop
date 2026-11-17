Attribute VB_Name = "Highlights"
' Highlights in the document, as yaqatw's web add-in makes them (yaqatw: src/host/
' WordDocumentHost.ts, src/service/highlightTag.ts): a rich-text content control around the text,
' tag "yaqatw:id=<uuid>" (legacy "yaqatw-tag": the control's own id is the highlight id), title
' the code names, a blue bounding box, the text highlighted in the last code's colour.
'
' Each function returns JSON text for Clew (WordOps.bas) or raises an error.
Option Explicit

Private Const ERR_HL As Long = vbObjectError + 720
' Characters of context kept on each side of a new highlight, as WordDocumentHost's ANCHOR_WINDOW.
Private Const ANCHOR_WINDOW As Long = 24

' ----------------------------------------------------------------------------------------------
' Tags and lookup

Public Function IsHighlightTag(ByVal tag As String) As Boolean
    IsHighlightTag = (Left$(tag, 6) = "yaqatw")
End Function

' The highlight id of a control: the id field of its tag, else Word's own id for the control.
Public Function HighlightIdOf(ByVal cc As ContentControl) As String
    Dim tag As String
    Dim sep As Long
    Dim pairs() As String
    Dim i As Long
    Dim eq As Long
    tag = cc.Tag
    sep = InStr(1, tag, ":")
    If sep > 0 Then
        pairs = Split(Mid$(tag, sep + 1), ";")
        For i = LBound(pairs) To UBound(pairs)
            eq = InStr(1, pairs(i), "=")
            If eq > 0 Then
                If Trim$(Left$(pairs(i), eq - 1)) = "id" Then
                    HighlightIdOf = Trim$(Mid$(pairs(i), eq + 1))
                    Exit Function
                End If
            End If
        Next i
    End If
    HighlightIdOf = cc.ID
End Function

Private Function FindHighlight(ByVal d As Document, ByVal hid As String) As ContentControl
    Dim cc As ContentControl
    For Each cc In d.ContentControls
        If IsHighlightTag(cc.Tag) Then
            If HighlightIdOf(cc) = hid Then
                Set FindHighlight = cc
                Exit Function
            End If
        End If
    Next cc
End Function

' The yaqatw highlight around a range (the innermost one), or Nothing.
Public Function HighlightAt(ByVal r As Range) As ContentControl
    Dim cc As ContentControl
    On Error GoTo None
    Set cc = r.ParentContentControl
    Do While Not cc Is Nothing
        If IsHighlightTag(cc.Tag) Then
            Set HighlightAt = cc
            Exit Function
        End If
        Set cc = cc.ParentContentControl
    Loop
None:
End Function

' ----------------------------------------------------------------------------------------------
' Colour: Word highlights come in 16 colours, so a code's colour gets the nearest of them.

Private Function HexToRgb(ByVal color As String, ByRef r As Long, ByRef g As Long, ByRef b As Long) As Boolean
    color = Trim$(color)
    If Left$(color, 1) = "#" Then color = Mid$(color, 2)
    If Len(color) = 3 Then color = Mid$(color, 1, 1) & Mid$(color, 1, 1) & Mid$(color, 2, 1) & Mid$(color, 2, 1) & Mid$(color, 3, 1) & Mid$(color, 3, 1)
    If Len(color) <> 6 Then Exit Function
    If Not color Like "[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]" Then Exit Function
    r = CLng("&H" & Mid$(color, 1, 2))
    g = CLng("&H" & Mid$(color, 3, 2))
    b = CLng("&H" & Mid$(color, 5, 2))
    HexToRgb = True
End Function

' The Word highlight colour for "#rrggbb", "#rgb" or a swatch label; wdNoHighlight when the colour
' cannot be read. The same rule as yaqatw's wordColor (src/service/wordColors.ts): yaqatw's 16
' swatch colours are Word's and map to themselves exactly; any other colour gets the Word colour
' of its hue, bright or dark by its lightness, or a grey when it has little colour in it. The
' host page sends palette colours only; this rule is the fallback.
Public Function NearestHighlight(ByVal colorValue As Variant) As WdColorIndex
    Dim names As Variant
    Dim indices As Variant
    Dim r As Long, g As Long, b As Long
    Dim i As Long
    Dim mx As Double, mn As Double
    Dim sat As Double
    Dim hue As Double
    Dim bright As Variant
    Dim dark As Variant
    Dim slot As Long
    Dim color As String
    color = CStr(colorValue)
    ' yaqatw's swatch labels.
    names = Array("white", "yellow", "lime", "turquoise", "pink", "blue", "red", "darkblue", "teal", "green", "purple", "darkred", "olive", "gray", "lightgray", "black")
    indices = Array(wdWhite, wdYellow, wdBrightGreen, wdTurquoise, wdPink, wdBlue, wdRed, wdDarkBlue, wdTeal, wdGreen, wdViolet, wdDarkRed, wdDarkYellow, wdGray50, wdGray25, wdBlack)
    For i = LBound(names) To UBound(names)
        If LCase$(Trim$(color)) = names(i) Then
            NearestHighlight = indices(i)
            Exit Function
        End If
    Next i
    If Not HexToRgb(color, r, g, b) Then
        NearestHighlight = wdNoHighlight
        Exit Function
    End If
    mx = r: If g > mx Then mx = g
    If b > mx Then mx = b
    mn = r: If g < mn Then mn = g
    If b < mn Then mn = b
    ' Too dark to tell a hue: black.
    If mx < 48 Then
        NearestHighlight = wdBlack
        Exit Function
    End If
    sat = (mx - mn) / mx
    If sat < 0.2 Then
        ' Little colour: white, a grey or black by lightness.
        If mx >= 224 Then
            NearestHighlight = wdWhite
        ElseIf mx >= 160 Then
            NearestHighlight = wdGray25
        ElseIf mx >= 64 Then
            NearestHighlight = wdGray50
        Else
            NearestHighlight = wdBlack
        End If
        Exit Function
    End If
    If mx = r Then
        hue = 60 * ((g - b) / (mx - mn))
    ElseIf mx = g Then
        hue = 60 * ((b - r) / (mx - mn)) + 120
    Else
        hue = 60 * ((r - g) / (mx - mn)) + 240
    End If
    If hue < 0 Then hue = hue + 360
    ' Six hues 60 degrees apart: red, yellow, green, turquoise, blue, pink.
    bright = Array(wdRed, wdYellow, wdBrightGreen, wdTurquoise, wdBlue, wdPink)
    dark = Array(wdDarkRed, wdDarkYellow, wdGreen, wdTeal, wdDarkBlue, wdViolet)
    slot = CLng(Int((hue + 30) / 60)) Mod 6
    If mx >= 160 Then NearestHighlight = bright(slot) Else NearestHighlight = dark(slot)
End Function

Private Sub Paint(ByVal cc As ContentControl, ByVal color As String)
    Dim idx As WdColorIndex
    If Len(color) = 0 Then Exit Sub
    idx = NearestHighlight(color)
    If idx <> wdNoHighlight Then cc.Range.HighlightColorIndex = idx
End Sub

' ----------------------------------------------------------------------------------------------
' Operations

' Codes the selection, with WordDocumentHost.processRange's rules: re-coding the same span, or
' the cursor inside a highlight, reuses that highlight; with noOverlap, a selection inside or
' across a highlight reuses it instead of wrapping a crossing one. `hid` is used for a new
' highlight when given. {hid, text, modified?, offset?, prefix?, suffix?}
Public Function InsertHighlightAtSelection(ByVal d As Document, ByVal title As String, ByVal color As String, _
        ByVal expandToParagraphs As Boolean, ByVal noOverlap As Boolean, ByVal givenHid As String) As String
    Dim sel As Selection
    Dim rng As Range
    Dim parent As ContentControl
    Dim target As ContentControl
    Dim cc As ContentControl
    Dim hasSelection As Boolean
    Dim reuse As Boolean
    Dim hid As String
    Dim text As String
    Dim before As String
    Dim after As String
    Dim stopAt As Long

    Set sel = SelectionOf(d)
    Set rng = sel.Range.Duplicate
    If expandToParagraphs And rng.Paragraphs.Count > 0 Then
        rng.Start = rng.Paragraphs(1).Range.Start
        rng.End = rng.Paragraphs(rng.Paragraphs.Count).Range.End - 1
    End If
    hasSelection = (sel.Type <> wdSelectionIP) And Len(Trim$(Replace(rng.Text, vbCr, ""))) > 0
    Set parent = Nothing
    On Error Resume Next
    Set parent = rng.ParentContentControl
    On Error GoTo 0

    If Not parent Is Nothing Then
        If IsHighlightTag(parent.Tag) And Trim$(parent.Range.Text) = Trim$(rng.Text) Then reuse = True
        If Not hasSelection Then reuse = True
        If reuse Then Set target = parent
    End If

    If noOverlap And hasSelection And Not reuse Then
        If Not parent Is Nothing Then
            If IsHighlightTag(parent.Tag) Then
                Set target = parent
                reuse = True
            End If
        End If
        If Not reuse Then
            For Each cc In rng.ContentControls
                If IsHighlightTag(cc.Tag) Then
                    Set target = cc
                    reuse = True
                    Exit For
                End If
            Next cc
        End If
    End If

    If Not reuse And Not hasSelection Then Err.Raise ERR_HL, "Highlights", "No text selected and no parent content control found"

    If Not reuse Then
        On Error GoTo Boundary
        Set cc = d.ContentControls.Add(wdContentControlRichText, rng)
        On Error GoTo 0
        hid = givenHid
        If Len(hid) = 0 Then hid = NewUuid()
        cc.title = title
        cc.Tag = "yaqatw:id=" & hid
        cc.Appearance = wdContentControlBoundingBox
        cc.Color = wdColorBlue
        Paint cc, color
        text = cc.Range.Text
        PlaceAfter sel, cc
        ' Where it is, to find it again should the control be lost (best effort).
        On Error Resume Next
        before = d.Range(d.Content.Start, cc.Range.Start - 1).Text
        stopAt = cc.Range.End + 1 + 4 * ANCHOR_WINDOW
        If stopAt > d.Content.End Then stopAt = d.Content.End
        after = d.Range(cc.Range.End + 1, stopAt).Text
        On Error GoTo 0
        InsertHighlightAtSelection = "{""hid"":" & JsonStr(hid) & ",""text"":" & JsonStr(text) & _
            ",""offset"":" & Len(before) & ",""prefix"":" & JsonStr(Right$(before, ANCHOR_WINDOW)) & _
            ",""suffix"":" & JsonStr(Left$(after, ANCHOR_WINDOW)) & "}"
    Else
        If IsHighlightTag(target.Tag) Then
            hid = HighlightIdOf(target)
        Else
            ' A content control of someone else's becomes a highlight.
            hid = NewUuid()
            target.Tag = "yaqatw:id=" & hid
            target.Appearance = wdContentControlBoundingBox
            target.Color = wdColorBlue
        End If
        Paint target, color
        text = target.Range.Text
        PlaceAfter sel, target
        InsertHighlightAtSelection = "{""hid"":" & JsonStr(hid) & ",""text"":" & JsonStr(text) & ",""modified"":true}"
    End If
    Exit Function
Boundary:
    If expandToParagraphs Then
        Err.Raise ERR_HL, "Highlights", Err.Description
    Else
        Err.Raise ERR_HL, "Highlights", "HighlightBoundaryError: Word cannot mark part of a list item. Select whole list items or paragraphs, then try again."
    End If
End Function

' The cursor right after the highlight, outside it, so typing on does not grow it.
Private Sub PlaceAfter(ByVal sel As Selection, ByVal cc As ContentControl)
    On Error Resume Next
    sel.SetRange cc.Range.End + 1, cc.Range.End + 1
End Sub

Public Function SelectionOf(ByVal d As Document) As Selection
    On Error GoTo NoWindow
    Set SelectionOf = d.ActiveWindow.Selection
    Exit Function
NoWindow:
    Err.Raise ERR_HL, "Highlights", "The document has no window."
End Function

Public Function SetHighlightTitle(ByVal d As Document, ByVal hid As String, ByVal title As String) As String
    Dim cc As ContentControl
    Set cc = FindHighlight(d, hid)
    If Not cc Is Nothing Then cc.title = title
    SetHighlightTitle = IIf(cc Is Nothing, "false", "true")
End Function

' Title and colour from the highlight's codes (worked out by the caller, as
' WordDocumentHost.applyHighlightUpdate does); remove when it has none left. An empty title or
' colour keeps what is there.
Public Function PaintHighlight(ByVal d As Document, ByVal hid As String, ByVal title As String, _
                               ByVal color As String, ByVal remove As Boolean) As String
    Dim cc As ContentControl
    Set cc = FindHighlight(d, hid)
    If cc Is Nothing Then
        PaintHighlight = "false"
        Exit Function
    End If
    If remove Then
        Unwrap cc
    Else
        If Len(title) > 0 Then cc.title = title
        Paint cc, color
    End If
    PaintHighlight = "true"
End Function

' The control goes, its text stays, without the highlight colour.
Private Sub Unwrap(ByVal cc As ContentControl)
    cc.Range.HighlightColorIndex = wdNoHighlight
    cc.Delete False
End Sub

Public Function RemoveHighlights(ByVal d As Document, hids As Variant) As String
    Dim wanted As New Collection
    Dim found As New Collection
    Dim cc As ContentControl
    Dim i As Long
    Dim hid As String
    Dim dummy As Variant
    If IsArray(hids) Then
        For i = LBound(hids) To UBound(hids)
            On Error Resume Next
            wanted.Add True, CStr(hids(i))
            On Error GoTo 0
        Next i
    End If
    For Each cc In d.ContentControls
        If IsHighlightTag(cc.Tag) Then
            hid = HighlightIdOf(cc)
            On Error Resume Next
            dummy = wanted(hid)
            If Err.Number = 0 Then found.Add cc
            Err.Clear
            On Error GoTo 0
        End If
    Next cc
    For i = 1 To found.Count
        Unwrap found(i)
    Next i
    RemoveHighlights = CStr(found.Count)
End Function

Public Function GoToHighlight(ByVal d As Document, ByVal hid As String) As String
    Dim cc As ContentControl
    Set cc = FindHighlight(d, hid)
    If cc Is Nothing Then
        GoToHighlight = "false"
        Exit Function
    End If
    SelectionOf(d).SetRange cc.Range.Start, cc.Range.End
    On Error Resume Next
    d.ActiveWindow.ScrollIntoView cc.Range, True
    GoToHighlight = "true"
End Function

' A content control by Word's own id (citations, legacy highlights): its start.
Public Function GoToControl(ByVal d As Document, ByVal controlId As String) As String
    Dim cc As ContentControl
    For Each cc In d.ContentControls
        If cc.ID = controlId Then
            SelectionOf(d).SetRange cc.Range.Start, cc.Range.Start
            On Error Resume Next
            d.ActiveWindow.ScrollIntoView cc.Range, True
            GoToControl = "true"
            Exit Function
        End If
    Next cc
    GoToControl = "false"
End Function

' [{hid, text}] in document order.
Public Function AllHighlights(ByVal d As Document) As String
    Dim cc As ContentControl
    Dim parts() As String
    Dim n As Long
    ReDim parts(0 To 15)
    For Each cc In d.ContentControls
        If IsHighlightTag(cc.Tag) Then
            If n > UBound(parts) Then ReDim Preserve parts(0 To 2 * UBound(parts) + 1)
            parts(n) = "{""hid"":" & JsonStr(HighlightIdOf(cc)) & ",""text"":" & JsonStr(cc.Range.Text) & "}"
            n = n + 1
        End If
    Next cc
    If n = 0 Then
        AllHighlights = "[]"
    Else
        ReDim Preserve parts(0 To n - 1)
        AllHighlights = "[" & Join(parts, ",") & "]"
    End If
End Function

' [{hid, paragraphIndices, order}]: the paragraphs each highlight touches, counted as
' getParagraphs counts them (paragraph marks in the document text), in document order.
' One pass over the text: each highlight's position is reached from the previous one's.
Public Function HighlightParagraphMap(ByVal d As Document) As String
    Dim cc As ContentControl
    Dim starts() As Long
    Dim ends() As Long
    Dim ids() As String
    Dim n As Long
    Dim i As Long
    Dim j As Long
    Dim pos As Long
    Dim para As Long
    Dim first As Long
    Dim last As Long
    Dim idx() As String
    Dim parts() As String
    Dim t As Long
    Dim swapL As Long
    Dim swapS As String

    ReDim starts(0 To 15): ReDim ends(0 To 15): ReDim ids(0 To 15)
    For Each cc In d.ContentControls
        If IsHighlightTag(cc.Tag) Then
            If n > UBound(starts) Then
                ReDim Preserve starts(0 To 2 * UBound(starts) + 1)
                ReDim Preserve ends(0 To UBound(starts))
                ReDim Preserve ids(0 To UBound(starts))
            End If
            starts(n) = cc.Range.Start
            ends(n) = cc.Range.End
            ids(n) = HighlightIdOf(cc)
            n = n + 1
        End If
    Next cc
    If n = 0 Then
        HighlightParagraphMap = "[]"
        Exit Function
    End If
    ' Document order (the collection usually is; nested controls may not be).
    For i = 1 To n - 1
        j = i
        Do While j > 0
            If starts(j - 1) <= starts(j) Then Exit Do
            swapL = starts(j): starts(j) = starts(j - 1): starts(j - 1) = swapL
            swapL = ends(j): ends(j) = ends(j - 1): ends(j - 1) = swapL
            swapS = ids(j): ids(j) = ids(j - 1): ids(j - 1) = swapS
            j = j - 1
        Loop
    Next i

    ReDim parts(0 To n - 1)
    pos = d.Content.Start
    para = 0
    For i = 0 To n - 1
        para = para + MarksBetween(d, pos, starts(i))
        pos = starts(i)
        first = para
        last = first + MarksBetween(d, starts(i), ends(i))
        ReDim idx(0 To last - first)
        For t = first To last
            idx(t - first) = CStr(t)
        Next t
        parts(i) = "{""hid"":" & JsonStr(ids(i)) & ",""paragraphIndices"":[" & Join(idx, ",") & "],""order"":" & i & "}"
    Next i
    HighlightParagraphMap = "[" & Join(parts, ",") & "]"
End Function

' Paragraph marks between two positions.
Private Function MarksBetween(ByVal d As Document, ByVal a As Long, ByVal b As Long) As Long
    Dim s As String
    If b <= a Then Exit Function
    s = ParagraphMarks(d.Range(a, b).Text)
    MarksBetween = Len(s) - Len(Replace(s, vbCr, ""))
End Function

' The highlight id under the cursor in this document, or null.
Public Function CurrentHighlight(ByVal d As Document) As String
    Dim cc As ContentControl
    On Error GoTo None
    Set cc = HighlightAt(SelectionOf(d).Range)
    If Not cc Is Nothing Then
        CurrentHighlight = JsonStr(HighlightIdOf(cc))
        Exit Function
    End If
None:
    CurrentHighlight = "null"
End Function

' Hidden: no box, no colour (yaqatw repaints after showing them again).
Public Function SetHighlightsVisible(ByVal d As Document, ByVal visible As Boolean) As String
    Dim cc As ContentControl
    For Each cc In d.ContentControls
        If IsHighlightTag(cc.Tag) Then
            If visible Then
                cc.Appearance = wdContentControlBoundingBox
            Else
                cc.Range.HighlightColorIndex = wdNoHighlight
                cc.Appearance = wdContentControlHidden
            End If
        End If
    Next cc
    SetHighlightsVisible = "null"
End Function
