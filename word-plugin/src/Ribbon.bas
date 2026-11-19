Attribute VB_Name = "Ribbon"
' The Yaqatw tab (customUI/customUI14.xml). Only these talk to the user.
' `control` is an IRibbonControl and `ribbon` an IRibbonUI, typed Object so no extra library
' reference is needed.
'
' The Coding group shows for analysis documents, the Writing group for writing documents, neither
' for a document without a type yet: the type is the document variable "yaqatw.fileType", which
' the Yaqatw window keeps in step with yaqatw. Their buttons are actions of the document's Yaqatw
' in Clew Desktop (Bridge.BridgeAction).
Option Explicit

Private Const TITLE As String = "Yaqatw"
Private Const NOT_RUNNING As String = "Clew Desktop is not running. Start it, then try again."
Private Const TYPE_VARIABLE As String = "yaqatw.fileType"
' What the document's Yaqatw can do for Word ("categories,relationships,..."), kept by its window.
Private Const FEATURES_VARIABLE As String = "yaqatw.features"
' At most this many codes in Apply code's menu; Find code finds the others.
Private Const MENU_CODES As Long = 25

Private ribbonUI As Object

' ----------------------------------------------------------------------------------------------
' The ribbon itself

Public Sub Ribbon_OnLoad(ByVal ribbon As Object)
    Set ribbonUI = ribbon
    ' Word's events follow the document in front, to show the groups for its type.
    BridgeEnsureEvents
End Sub

' Shows each group for the active document's type again (switching documents, a type changed).
Public Sub RibbonRefresh()
    On Error Resume Next
    If Not ribbonUI Is Nothing Then ribbonUI.Invalidate
End Sub

' A document variable of the active document, or "" (none, or no document).
Private Function DocVariable(ByVal name As String) As String
    Dim v As Variable
    On Error GoTo None
    If Documents.Count = 0 Then Exit Function
    For Each v In ActiveDocument.Variables
        If v.Name = name Then
            DocVariable = v.Value
            Exit Function
        End If
    Next v
None:
End Function

' The active document's type: "analyze", "write" or "" (none yet, or no document).
Private Function DocType() As String
    DocType = DocVariable(TYPE_VARIABLE)
End Function

' Whether the document's Yaqatw said it can do `name` for Word (a Yaqatw too old for a menu
' hides it rather than failing on click).
Private Function HasFeature(ByVal name As String) As Boolean
    HasFeature = InStr(1, "," & DocVariable(FEATURES_VARIABLE) & ",", "," & name & ",", vbBinaryCompare) > 0
End Function

' A group whose tag is a document type shows for that type only: a document without a type has
' the common group alone (Clew Desktop) until its type is chosen in Yaqatw.
Public Sub Ribbon_GetVisible(ByVal control As Object, ByRef visible As Variant)
    visible = (DocType() = control.Tag)
End Sub

' ----------------------------------------------------------------------------------------------
' Clew Desktop group

' Open Yaqatw: a Clew Desktop window on this document (Bridge.bas), or its window again.
Public Sub Ribbon_Open(ByVal control As Object)
    Dim result As String
    result = BridgeOpen()
    Select Case True
        Case Left$(result, 3) = "ok:"
        Case result = "no-document": MsgBox "Open a document first.", vbExclamation, TITLE
        Case result = "not-running": MsgBox NOT_RUNNING, vbExclamation, TITLE
        Case result = "unpaired"
            If Reconnect() Then Ribbon_Open control
        Case Else: MsgBox "Could not open Yaqatw in Clew Desktop (" & result & ").", vbExclamation, TITLE
    End Select
End Sub

' Connection: says whether Yaqatw for Word is connected. Clew connects it when it installs it;
' if that was lost, this offers to connect again (Clew asks the user to confirm).
Public Sub Ribbon_Connect(ByVal control As Object)
    Dim state As String
    If ClewHello() <> "ok" Then
        MsgBox NOT_RUNNING, vbExclamation, TITLE
        Exit Sub
    End If
    state = ClewCheck()
    If Left$(state, 7) = "paired:" Then
        MsgBox "Yaqatw for Word is connected to Clew Desktop.", vbInformation, TITLE
    Else
        Reconnect
    End If
End Sub

' Asks before pairing again; True once connected.
Private Function Reconnect() As Boolean
    If MsgBox("Yaqatw for Word is not connected to Clew Desktop. Connect now?" & vbCr & vbCr & _
              "Clew Desktop will ask you to confirm.", vbQuestion + vbYesNo, TITLE) <> vbYes Then Exit Function
    Select Case ClewPair()
        Case "paired"
            Reconnect = True
            MsgBox "Yaqatw for Word is connected to Clew Desktop.", vbInformation, TITLE
        Case "refused": MsgBox "Clew Desktop did not allow the connection.", vbExclamation, TITLE
        Case "timeout": MsgBox "Nobody answered in Clew Desktop. Try again.", vbExclamation, TITLE
        Case "busy": MsgBox "Clew Desktop is already asking about another connection. Answer it first.", vbExclamation, TITLE
        Case "not-running": MsgBox "Clew Desktop stopped answering.", vbExclamation, TITLE
        Case Else: MsgBox "Could not connect to Clew Desktop.", vbExclamation, TITLE
    End Select
End Function

' ----------------------------------------------------------------------------------------------
' Coding group

' Runs an action of the document's Yaqatw; on failure says why. The answer's value (JSON), or ""
' after a failure. An answer with a "status" puts it in Word's status bar.
Private Function Act(ByVal action As String, Optional ByVal argsJson As String = "{}", _
                     Optional ByVal waitSeconds As Long = 120) As String
    Dim r As String
    r = BridgeAction(action, argsJson, waitSeconds)
    BridgeKeepTicking
    If Left$(r, 3) = "ok:" Then
        Act = Mid$(r, 4)
        ShowStatus Act
        Exit Function
    End If
    If r = "error:unpaired" Then
        Reconnect
    Else
        MsgBox Mid$(r, 7), vbExclamation, TITLE
    End If
    Act = ""
End Function

' Apply code: the menu, filled when it opens (invalidateContentOnDrop): the codes, recently
' applied first, then Find code and New code. The same menu in Word's right-click menus
' (yaqatwCtxApply...) has In vivo too, and ids of its own: two menus may not share an id.
Public Sub Ribbon_CodesMenu(ByVal control As Object, ByRef content As Variant)
    Dim r As String
    Dim answer As Variant
    Dim codes As Variant
    Dim items As String
    Dim i As Long
    Dim n As Long
    Dim note As String
    Dim c As Variant
    Dim ellipsis As String
    Dim pre As String
    ellipsis = ChrW$(8230)
    Select Case control.Id
        Case "yaqatwCtxApply": pre = "yx"
        Case "yaqatwCtxApplyList": pre = "yl"
        Case "yaqatwCtxApplySpell": pre = "ys"
        Case Else: pre = "yc"
    End Select
    r = BridgeAction("codes", "{}", 60)
    If Left$(r, 3) <> "ok:" Then
        items = MenuNote(pre, Mid$(r, 7))
    Else
        On Error Resume Next
        Set answer = JsonParse(Mid$(r, 4))
        On Error GoTo 0
        ' Why codes cannot be applied here (the document's type), as the Yaqatw window says it.
        note = JsonGet(answer, "note", "") & ""
        If Len(note) > 0 Then
            items = MenuNote(pre, note)
        Else
            ' In the order given: recently applied first (the Yaqatw window keeps that list).
            codes = JsonGet(answer, "codes")
            If ArrayCount(codes) > 0 Then
                For i = LBound(codes) To UBound(codes)
                    Set c = codes(i)
                    n = n + 1
                    If n > MENU_CODES Then Exit For
                    items = items & "<button id=""" & pre & n & """ label=""" & XmlAttr(Left$(JsonGet(c, "name", ""), 60)) & _
                        """ tag=""" & XmlAttr(JsonGet(c, "color", "") & "|" & JsonGet(c, "id", "")) & _
                        """ getImage=""Ribbon_CodeImage"" onAction=""Ribbon_CodeItem""" & _
                        IIf(Len(JsonGet(c, "description", "")) > 0, " screentip=""" & XmlAttr(Left$(JsonGet(c, "description", ""), 200)) & """", "") & _
                        "/>"
                Next i
            End If
            If n = 0 Then items = MenuNote(pre, "No codes yet: New code creates the first.")
        End If
    End If
    items = items & "<menuSeparator id=""" & pre & "Sep""/>"
    If pre <> "yc" Then items = items & "<button id=""" & pre & "InVivo"" label=""In vivo"" imageMso=""QuickStylesGallery"" onAction=""Ribbon_InVivo""/>"
    items = items & _
        "<button id=""" & pre & "Find"" label=""Find code" & ellipsis & """ imageMso=""ResearchPane"" onAction=""Ribbon_PickCode""/>" & _
        "<button id=""" & pre & "New"" label=""New code" & ellipsis & """ imageMso=""NameDefine"" onAction=""Ribbon_NewCode""/>"
    content = "<menu xmlns=""http://schemas.microsoft.com/office/2009/07/customui"">" & items & "</menu>"
End Sub

' What an action did, in one line of Word's status bar (its answer's "status"), if it says.
Private Sub ShowStatus(ByVal answerJson As String)
    Dim text As String
    If Left$(answerJson, 1) <> "{" Then Exit Sub
    text = JsonString(answerJson, "status")
    If Len(text) = 0 Then Exit Sub
    On Error Resume Next
    Application.StatusBar = text
End Sub

Private Function MenuNote(ByVal pre As String, ByVal text As String) As String
    MenuNote = "<button id=""" & pre & "Note"" label=""" & XmlAttr(Left$(text, 120)) & """ enabled=""false""/>"
End Function

' A code in Apply code's menu: applied to the selection (the Yaqatw window notes it among the
' codes applied lately). Its tag is "<colour>|<id>".
Public Sub Ribbon_CodeItem(ByVal control As Object)
    Dim codeId As String
    codeId = Mid$(control.Tag, InStr(1, control.Tag, "|") + 1)
    Act "applyCode", "{""codeId"":" & JsonStr(codeId) & "}"
End Sub

' The code's colour as a small square (CodeImages.bas).
Public Sub Ribbon_CodeImage(ByVal control As Object, ByRef image As Variant)
    Dim pic As Object
    Set pic = ColorPicture(Left$(control.Tag, InStr(1, control.Tag & "|", "|") - 1))
    If Not pic Is Nothing Then Set image = pic
End Sub

' Find code: Clew's code picker (type to find, Enter applies), in front of Word.
Public Sub Ribbon_PickCode(ByVal control As Object)
    ClewAllowForeground
    Act "openPicker", "{""mode"":""find""}"
End Sub

' New code: the picker, on its new-code form (name, Word's colours, description).
Public Sub Ribbon_NewCode(ByVal control As Object)
    ClewAllowForeground
    Act "openPicker", "{""mode"":""new""}"
End Sub

' In vivo: a code named after the selected text, applied to it.
Public Sub Ribbon_InVivo(ByVal control As Object)
    Act "inVivo"
End Sub

' Highlight info: the coded passage at the cursor (its text, translation, notes and codes) in a
' Clew Desktop window, as Yaqatw shows it when a highlight is clicked.
Public Sub Ribbon_HighlightInfo(ByVal control As Object)
    Dim hid As String
    If Documents.Count = 0 Then Exit Sub
    hid = CursorHighlight()
    If Len(hid) = 0 Then
        MsgBox "Put the cursor in a coded passage first.", vbInformation, TITLE
        Exit Sub
    End If
    ClewAllowForeground
    Act "openPicker", "{""mode"":""info"",""hid"":" & JsonStr(hid) & "}"
End Sub

' The id of the coded passage at the cursor, or "" when the cursor is in none.
Private Function CursorHighlight() As String
    Dim cc As ContentControl
    If Documents.Count = 0 Then Exit Function
    On Error Resume Next
    Set cc = HighlightAt(SelectionOf(ActiveDocument).Range)
    On Error GoTo 0
    If Not cc Is Nothing Then CursorHighlight = HighlightIdOf(cc)
End Function

' ----------------------------------------------------------------------------------------------
' Add to category (Word's right-click menus, in a coded passage). A category holds codes, so the
' menu is about the passage's codes: with one code, every category (ticked when the code is in
' it: a click adds or removes) and New category; with several, a submenu of those for each code.

' Add to category and Highlight info in the right-click menus: shown in an analysis document,
' with the cursor in a coded passage (Word moves the cursor where the right-click is).
Public Sub Ribbon_PassageVisible(ByVal control As Object, ByRef visible As Variant)
    visible = False
    If DocType() <> "analyze" Then Exit Sub
    visible = (Len(CursorHighlight()) > 0)
End Sub

' The menu, filled when it opens. Ids of its own in each right-click menu (as Apply code's).
Public Sub Ribbon_CategoriesMenu(ByVal control As Object, ByRef content As Variant)
    Dim pre As String
    Dim hid As String
    Dim r As String
    Dim items As String
    Dim answer As Variant
    Dim codes As Variant
    Dim cats As Variant
    Dim i As Long
    Dim c As Variant
    Select Case control.Id
        Case "yaqatwCtxCatList": pre = "zl"
        Case "yaqatwCtxCatSpell": pre = "zs"
        Case Else: pre = "zx"
    End Select
    hid = CursorHighlight()
    If Len(hid) = 0 Then
        items = MenuNote(pre, "Put the cursor in a coded passage first.")
    Else
        r = BridgeAction("categoryMenu", "{""hid"":" & JsonStr(hid) & "}", 60)
        If Left$(r, 3) <> "ok:" Then
            items = MenuNote(pre, Mid$(r, 7))
        Else
            On Error Resume Next
            Set answer = JsonParse(Mid$(r, 4))
            On Error GoTo 0
            codes = JsonGet(answer, "codes")
            cats = JsonGet(answer, "categories")
            If ArrayCount(codes) = 0 Then
                items = MenuNote(pre, "This passage has no code.")
            ElseIf ArrayCount(codes) = 1 Then
                items = CategoryItems(pre & "a", codes(LBound(codes)), cats)
            Else
                For i = LBound(codes) To UBound(codes)
                    Set c = codes(i)
                    items = items & "<menu id=""" & pre & "m" & i & """ label=""" & XmlAttr(Left$(JsonGet(c, "name", ""), 60)) & _
                        """ tag=""" & XmlAttr(JsonGet(c, "color", "") & "|" & JsonGet(c, "id", "")) & _
                        """ getImage=""Ribbon_CodeImage"">" & CategoryItems(pre & i & "x", c, cats) & "</menu>"
                Next i
            End If
        End If
    End If
    content = "<menu xmlns=""http://schemas.microsoft.com/office/2009/07/customui"">" & items & "</menu>"
End Sub

' A code's choices: every category, ticked when the code is in it (a click puts the code in or
' takes it out; tag "<1 or 0>|<category id>|<code id>"), then New category (tag "<code id>").
Private Function CategoryItems(ByVal pfx As String, ByVal code As Variant, ByVal cats As Variant) As String
    Dim inIds As Variant
    Dim items As String
    Dim codeId As String
    Dim catId As String
    Dim i As Long
    Dim j As Long
    Dim found As Boolean
    codeId = JsonGet(code, "id", "")
    inIds = JsonGet(code, "categories")
    If ArrayCount(cats) = 0 Then
        items = "<button id=""" & pfx & "none"" label=""No categories yet"" enabled=""false""/>"
    Else
        For i = LBound(cats) To UBound(cats)
            catId = JsonGet(cats(i), "id", "")
            found = False
            If ArrayCount(inIds) > 0 Then
                For j = LBound(inIds) To UBound(inIds)
                    If inIds(j) = catId Then
                        found = True
                        Exit For
                    End If
                Next j
            End If
            items = items & "<checkBox id=""" & pfx & "c" & i & """ label=""" & XmlAttr(Left$(JsonGet(cats(i), "name", ""), 60)) & _
                """ tag=""" & XmlAttr(IIf(found, "1", "0") & "|" & catId & "|" & codeId) & _
                """ getPressed=""Ribbon_CategoryPressed"" onAction=""Ribbon_CategoryToggle""/>"
        Next i
    End If
    items = items & "<menuSeparator id=""" & pfx & "sep""/>" & _
        "<button id=""" & pfx & "new"" label=""New category" & ChrW$(8230) & """ imageMso=""CategorizeMenu"" tag=""" & _
        XmlAttr(codeId) & """ onAction=""Ribbon_NewCategory""/>"
    CategoryItems = items
End Function

' The number of items of a parsed JSON array (0 for anything else).
Private Function ArrayCount(ByVal v As Variant) As Long
    If Not IsArray(v) Then Exit Function
    On Error Resume Next
    ArrayCount = UBound(v) - LBound(v) + 1
End Function

' A tick of Add to category or Add to relationship: ticked when the code is in the category or
' instance (its tag starts with "1").
Public Sub Ribbon_CategoryPressed(ByVal control As Object, ByRef pressed As Variant)
    pressed = (Left$(control.Tag, 1) = "1")
End Sub

' A category clicked: the code goes in it, or out of it when it was ticked.
Public Sub Ribbon_CategoryToggle(ByVal control As Object, ByVal pressed As Boolean)
    Dim parts() As String
    parts = Split(control.Tag, "|")
    If UBound(parts) < 2 Then Exit Sub
    Act IIf(pressed, "addToCategory", "removeFromCategory"), _
        "{""categoryId"":" & JsonStr(parts(1)) & ",""codeId"":" & JsonStr(parts(2)) & "}"
End Sub

' New category: Clew's small window (name, description), in front of Word; the category is made
' with the code in it.
Public Sub Ribbon_NewCategory(ByVal control As Object)
    ClewAllowForeground
    Act "openPicker", "{""mode"":""category"",""code"":" & JsonStr(control.Tag) & "}"
End Sub

' ----------------------------------------------------------------------------------------------
' Add to relationship (Word's right-click menus, in a coded passage). A relationship holds codes
' and categories in its instances. The items: the passage's codes, then the categories they are
' directly in (a submenu per item when there are several). For each, every relationship: with
' one instance, a tick; otherwise a submenu of its instances' ticks and New instance. Then New
' relationship. More... opens the window (relate.html), which has parent categories too.
' In tags an item is "<id>|<c or k>" (code, category).

' Shown as Add to category, when the document's Yaqatw can do relationships for Word.
Public Sub Ribbon_RelationsVisible(ByVal control As Object, ByRef visible As Variant)
    visible = False
    If Not HasFeature("relationships") Then Exit Sub
    Ribbon_PassageVisible control, visible
End Sub

' The menu, filled when it opens. Ids of its own in each right-click menu (as Apply code's).
Public Sub Ribbon_RelationshipsMenu(ByVal control As Object, ByRef content As Variant)
    Dim pre As String
    Dim hid As String
    Dim r As String
    Dim items As String
    Dim answer As Variant
    Dim things As Variant
    Dim i As Long
    Dim it As Variant
    Select Case control.Id
        Case "yaqatwCtxRelList": pre = "rl"
        Case "yaqatwCtxRelSpell": pre = "rs"
        Case Else: pre = "rx"
    End Select
    hid = CursorHighlight()
    If Len(hid) = 0 Then
        items = MenuNote(pre, "Put the cursor in a coded passage first.")
    Else
        r = BridgeAction("relationshipMenu", "{""hid"":" & JsonStr(hid) & "}", 60)
        If Left$(r, 3) <> "ok:" Then
            items = MenuNote(pre, Mid$(r, 7))
        Else
            On Error Resume Next
            Set answer = JsonParse(Mid$(r, 4))
            On Error GoTo 0
            things = JsonGet(answer, "items")
            If ArrayCount(things) = 0 Then
                items = MenuNote(pre, "This passage has no code.")
            ElseIf ArrayCount(things) = 1 Then
                items = RelationItems(pre & "a", things(LBound(things)))
            Else
                For i = LBound(things) To UBound(things)
                    Set it = things(i)
                    items = items & "<menu id=""" & pre & "m" & i & """ label=""" & XmlAttr(Left$(JsonGet(it, "name", ""), 60)) & """"
                    If JsonGet(it, "kind", "") = "category" Then
                        items = items & " imageMso=""CategorizeMenu"""
                    Else
                        items = items & " tag=""" & XmlAttr(JsonGet(it, "color", "") & "|" & JsonGet(it, "id", "")) & _
                            """ getImage=""Ribbon_CodeImage"""
                    End If
                    items = items & ">" & RelationItems(pre & i & "x", it) & "</menu>"
                Next i
            End If
            items = items & "<menuSeparator id=""" & pre & "moreSep""/>" & _
                "<button id=""" & pre & "more"" label=""More" & ChrW$(8230) & """ tag=""" & XmlAttr(hid) & _
                """ screentip=""Parent categories too, in a window"" onAction=""Ribbon_RelateWindow""/>"
        End If
    End If
    content = "<menu xmlns=""http://schemas.microsoft.com/office/2009/07/customui"">" & items & "</menu>"
End Sub

' An item's choices: every relationship (a tick, or a submenu of its instances and New instance),
' then New relationship (tag "<item id>|<c or k>").
Private Function RelationItems(ByVal pfx As String, ByVal thing As Variant) As String
    Dim rels As Variant
    Dim insts As Variant
    Dim items As String
    Dim item As String
    Dim relId As String
    Dim menuId As String
    Dim i As Long
    Dim j As Long
    item = JsonGet(thing, "id", "") & "|" & IIf(JsonGet(thing, "kind", "") = "category", "k", "c")
    rels = JsonGet(thing, "relationships")
    If ArrayCount(rels) = 0 Then
        items = "<button id=""" & pfx & "none"" label=""No relationships yet"" enabled=""false""/>"
    Else
        For i = LBound(rels) To UBound(rels)
            relId = JsonGet(rels(i), "id", "")
            insts = JsonGet(rels(i), "instances")
            If ArrayCount(insts) = 1 Then
                items = items & InstanceBox(pfx & "r" & i, JsonGet(rels(i), "name", ""), relId, insts(LBound(insts)), item)
            Else
                menuId = pfx & "m" & i
                items = items & "<menu id=""" & menuId & """ label=""" & XmlAttr(Left$(JsonGet(rels(i), "name", ""), 60)) & """>"
                If ArrayCount(insts) > 0 Then
                    For j = LBound(insts) To UBound(insts)
                        items = items & InstanceBox(menuId & "i" & j, JsonGet(insts(j), "name", ""), relId, insts(j), item)
                    Next j
                    items = items & "<menuSeparator id=""" & menuId & "s""/>"
                End If
                items = items & "<button id=""" & menuId & "n"" label=""New instance"" tag=""" & XmlAttr(relId & "|" & item) & _
                    """ onAction=""Ribbon_NewInstance""/></menu>"
            End If
        Next i
    End If
    items = items & "<menuSeparator id=""" & pfx & "sep""/>" & _
        "<button id=""" & pfx & "new"" label=""New relationship" & ChrW$(8230) & """ imageMso=""SmartArtInsert"" tag=""" & _
        XmlAttr(item) & """ onAction=""Ribbon_NewRelationship""/>"
    RelationItems = items
End Function

' An instance's tick: tag "<1 or 0>|<relationship id>|<instance id>|<item id>|<c or k>".
Private Function InstanceBox(ByVal id As String, ByVal label As Variant, ByVal relId As String, _
                             ByVal inst As Variant, ByVal item As String) As String
    InstanceBox = "<checkBox id=""" & id & """ label=""" & XmlAttr(Left$(label, 60)) & """ tag=""" & _
        XmlAttr(IIf(JsonGet(inst, "holds", False) = True, "1", "0") & "|" & relId & "|" & JsonGet(inst, "id", "") & "|" & item) & _
        """ getPressed=""Ribbon_CategoryPressed"" onAction=""Ribbon_InstanceToggle""/>"
End Function

' The JSON members naming an item: its id and whether it is a code or a category.
Private Function ItemArgs(ByVal itemId As String, ByVal kind As String) As String
    ItemArgs = """itemId"":" & JsonStr(itemId) & ",""kind"":" & JsonStr(IIf(kind = "k", "category", "code"))
End Function

' An instance clicked: the item goes in it, or out of it when it was ticked.
Public Sub Ribbon_InstanceToggle(ByVal control As Object, ByVal pressed As Boolean)
    Dim parts() As String
    parts = Split(control.Tag, "|")
    If UBound(parts) < 4 Then Exit Sub
    Act IIf(pressed, "addToRelationship", "removeFromRelationship"), _
        "{""relationshipId"":" & JsonStr(parts(1)) & ",""instanceId"":" & JsonStr(parts(2)) & "," & _
        ItemArgs(parts(3), parts(4)) & "}"
End Sub

' New instance: one more instance of the relationship (Yaqatw names it), holding the item.
Public Sub Ribbon_NewInstance(ByVal control As Object)
    Dim parts() As String
    parts = Split(control.Tag, "|")
    If UBound(parts) < 2 Then Exit Sub
    Act "newInstance", "{""relationshipId"":" & JsonStr(parts(0)) & "," & ItemArgs(parts(1), parts(2)) & "}"
End Sub

' New relationship: Clew's small window (name, description), in front of Word; its first instance
' holds the item.
Public Sub Ribbon_NewRelationship(ByVal control As Object)
    Dim parts() As String
    parts = Split(control.Tag, "|")
    If UBound(parts) < 1 Then Exit Sub
    ClewAllowForeground
    Act "openPicker", "{""mode"":""relationship"",""code"":" & JsonStr(parts(0)) & _
        IIf(parts(1) = "k", ",""item"":""category""", "") & "}"
End Sub

' More...: Add to relationship as a window, with the categories' parents (tag: the passage).
Public Sub Ribbon_RelateWindow(ByVal control As Object)
    ClewAllowForeground
    Act "openPicker", "{""mode"":""relate"",""hid"":" & JsonStr(control.Tag) & "}"
End Sub

' ----------------------------------------------------------------------------------------------
' Writing group: Writing > Cite of the document's Yaqatw

' Insert quote / Insert artifact / Find and insert: Clew's insert window (type to find, Enter
' inserts at the cursor), searching first what the button's tag says.
Public Sub Ribbon_Insert(ByVal control As Object)
    ClewAllowForeground
    Act "openPicker", "{""mode"":""insert"",""source"":" & JsonStr(control.Tag) & "}"
End Sub

' Refresh: every linked quote, figure and table in the document from its source, as now.
Public Sub Ribbon_RefreshCitations(ByVal control As Object)
    If Len(Act("refreshCitations", "{}", 300)) > 0 Then
        MsgBox "The quotes, figures and tables are up to date.", vbInformation, TITLE
    End If
End Sub

' Unlink all: keeps the text, figures and tables, without their links to the sources.
Public Sub Ribbon_UnlinkCitations(ByVal control As Object)
    If MsgBox("Unlink every quote, figure and table in this document?" & vbCr & vbCr & _
              "They stay in the document as they are, but Refresh will no longer update them.", _
              vbQuestion + vbYesNo + vbDefaultButton2, TITLE) <> vbYes Then Exit Sub
    Act "unlinkCitations", "{}", 300
End Sub

' ----------------------------------------------------------------------------------------------

' Text for an XML attribute in the ribbon's menu.
Private Function XmlAttr(ByVal value As Variant) As String
    Dim s As String
    s = CStr(value)
    s = Replace(s, "&", "&amp;")
    s = Replace(s, "<", "&lt;")
    s = Replace(s, ">", "&gt;")
    s = Replace(s, """", "&quot;")
    s = Replace(s, vbCr, " ")
    s = Replace(s, vbLf, " ")
    XmlAttr = s
End Function
