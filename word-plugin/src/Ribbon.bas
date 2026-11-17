Attribute VB_Name = "Ribbon"
' The Yaqatw tab (customUI/customUI14.xml). Only these talk to the user.
' `control` is an IRibbonControl and `ribbon` an IRibbonUI, typed Object so no extra library
' reference is needed.
'
' The Coding group shows for analysis documents (and for documents without a type yet): the type
' is the document variable "yaqatw.fileType", which the Yaqatw window keeps in step with yaqatw.
' Its buttons are actions of the document's Yaqatw in Clew Desktop (Bridge.BridgeAction).
Option Explicit

Private Const TITLE As String = "Yaqatw"
Private Const NOT_RUNNING As String = "Clew Desktop is not running. Start it, then try again."
Private Const TYPE_VARIABLE As String = "yaqatw.fileType"
' At most this many codes in Apply code's menu; Find code finds the others.
Private Const MENU_CODES As Long = 25

Private ribbonUI As Object
Private recentCodes As Collection   ' code ids, most recently applied first

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

' The active document's type: "analyze", "write" or "" (none yet, or no document).
Private Function DocType() As String
    Dim v As Variable
    On Error GoTo None
    If Documents.Count = 0 Then Exit Function
    For Each v In ActiveDocument.Variables
        If v.Name = TYPE_VARIABLE Then
            DocType = v.Value
            Exit Function
        End If
    Next v
None:
End Function

' A group whose tag is a document type shows for that type, and for a document without one.
Public Sub Ribbon_GetVisible(ByVal control As Object, ByRef visible As Variant)
    Dim t As String
    t = DocType()
    visible = (Len(t) = 0 Or t = control.Tag)
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
' after a failure.
Private Function Act(ByVal action As String, Optional ByVal argsJson As String = "{}") As String
    Dim r As String
    r = BridgeAction(action, argsJson)
    If Left$(r, 3) = "ok:" Then
        Act = Mid$(r, 4)
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
' applied first, then Find code and New code.
Public Sub Ribbon_CodesMenu(ByVal control As Object, ByRef content As Variant)
    Dim r As String
    Dim answer As Variant
    Dim codes As Variant
    Dim items As String
    Dim i As Long
    Dim n As Long
    Dim order As Collection
    Dim c As Variant
    Dim ellipsis As String
    ellipsis = ChrW$(8230)
    r = BridgeAction("codes", "{}", 60)
    If Left$(r, 3) <> "ok:" Then
        items = MenuNote(Mid$(r, 7))
    Else
        On Error Resume Next
        Set answer = JsonParse(Mid$(r, 4))
        On Error GoTo 0
        If JsonGet(answer, "fileType", "") = "write" Then
            items = MenuNote("This is a writing document: codes are applied in analysis documents.")
        ElseIf JsonGet(answer, "fileType", "") <> "analyze" Then
            items = MenuNote("Choose this document's type first: Open Yaqatw, then Settings, Document type: Analysis.")
        Else
            codes = JsonGet(answer, "codes")
            Set order = ByRecent(codes)
            For Each c In order
                n = n + 1
                If n > MENU_CODES Then Exit For
                items = items & "<button id=""yc" & n & """ label=""" & XmlAttr(Left$(JsonGet(c, "name", ""), 60)) & _
                    """ tag=""" & XmlAttr(JsonGet(c, "color", "") & "|" & JsonGet(c, "id", "")) & _
                    """ getImage=""Ribbon_CodeImage"" onAction=""Ribbon_CodeItem""" & _
                    IIf(Len(JsonGet(c, "description", "")) > 0, " screentip=""" & XmlAttr(Left$(JsonGet(c, "description", ""), 200)) & """", "") & _
                    "/>"
            Next c
            If n = 0 Then items = MenuNote("No codes yet: New code creates the first.")
        End If
    End If
    items = items & "<menuSeparator id=""ycSep""/>" & _
        "<button id=""ycFind"" label=""Find code" & ellipsis & """ imageMso=""FindDialog"" onAction=""Ribbon_PickCode""/>" & _
        "<button id=""ycNew"" label=""New code" & ellipsis & """ imageMso=""FileNew"" onAction=""Ribbon_NewCode""/>"
    content = "<menu xmlns=""http://schemas.microsoft.com/office/2009/07/customui"">" & items & "</menu>"
End Sub

Private Function MenuNote(ByVal text As String) As String
    MenuNote = "<button id=""ycNote"" label=""" & XmlAttr(Left$(text, 120)) & """ enabled=""false""/>"
End Function

' The codes in menu order: recently applied first, then the project's order.
Private Function ByRecent(ByVal codes As Variant) As Collection
    Dim out As New Collection
    Dim byId As New Collection
    Dim i As Long
    Dim c As Variant
    Dim id As Variant
    If Not IsArray(codes) Then
        Set ByRecent = out
        Exit Function
    End If
    If UBound(codes) < LBound(codes) Then
        Set ByRecent = out
        Exit Function
    End If
    On Error Resume Next
    For i = LBound(codes) To UBound(codes)
        byId.Add codes(i), CStr(JsonGet(codes(i), "id", ""))
    Next i
    If Not recentCodes Is Nothing Then
        For Each id In recentCodes
            Set c = Nothing
            Set c = byId(CStr(id))
            If Not c Is Nothing Then out.Add c, CStr(id)
        Next id
    End If
    For i = LBound(codes) To UBound(codes)
        out.Add codes(i), CStr(JsonGet(codes(i), "id", ""))
    Next i
    On Error GoTo 0
    Set ByRecent = out
End Function

Private Sub Remember(ByVal codeId As String)
    Dim i As Long
    If recentCodes Is Nothing Then Set recentCodes = New Collection
    For i = recentCodes.Count To 1 Step -1
        If recentCodes(i) = codeId Then recentCodes.Remove i
    Next i
    If recentCodes.Count = 0 Then recentCodes.Add codeId Else recentCodes.Add codeId, Before:=1
    Do While recentCodes.Count > 20
        recentCodes.Remove recentCodes.Count
    Loop
End Sub

' A code in Apply code's menu: applied to the selection. Its tag is "<colour>|<id>".
Public Sub Ribbon_CodeItem(ByVal control As Object)
    Dim codeId As String
    codeId = Mid$(control.Tag, InStr(1, control.Tag, "|") + 1)
    If Len(Act("applyCode", "{""codeId"":" & JsonStr(codeId) & "}")) > 0 Then Remember codeId
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
