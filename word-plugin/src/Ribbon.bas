Attribute VB_Name = "Ribbon"
' The yaqatw tab's buttons (customUI/customUI14.xml). Only these talk to the user.
' `control` is an IRibbonControl, typed Object so no extra library reference is needed.
Option Explicit

Private Const TITLE As String = "yaqatw"

' Connect: checks that Clew Desktop runs, and pairs with it if this template is not paired yet.
Public Sub Ribbon_Connect(ByVal control As Object)
    Dim state As String
    If ClewHello() <> "ok" Then
        MsgBox "Clew Desktop is not running. Start it, then try again.", vbExclamation, TITLE
        Exit Sub
    End If
    state = ClewCheck()
    If Left$(state, 7) = "paired:" Then
        MsgBox "Connected to Clew Desktop as """ & Mid$(state, 8) & """.", vbInformation, TITLE
        Exit Sub
    End If
    MsgBox "Clew Desktop will now ask whether to allow this connection. Answer there.", vbInformation, TITLE
    Select Case ClewPair()
        Case "paired": MsgBox "Connected to Clew Desktop.", vbInformation, TITLE
        Case "refused": MsgBox "Clew Desktop did not allow the connection.", vbExclamation, TITLE
        Case "timeout": MsgBox "Nobody answered in Clew Desktop. Try again.", vbExclamation, TITLE
        Case "busy": MsgBox "Clew Desktop is already asking about another connection. Answer it first.", vbExclamation, TITLE
        Case "not-running": MsgBox "Clew Desktop stopped answering.", vbExclamation, TITLE
        Case Else: MsgBox "Could not connect to Clew Desktop.", vbExclamation, TITLE
    End Select
End Sub

' Mark selection: asks Clew who this template is, and marks the selection with that name.
Public Sub Ribbon_Mark(ByVal control As Object)
    Dim state As String
    Dim result As String
    state = ClewCheck()
    If state = "not-running" Then
        MsgBox "Clew Desktop is not running. Start it, then try again.", vbExclamation, TITLE
        Exit Sub
    ElseIf Left$(state, 7) <> "paired:" Then
        MsgBox "Connect to Clew Desktop first (yaqatw > Connect).", vbExclamation, TITLE
        Exit Sub
    End If
    result = InsertMark("Clew: " & Mid$(state, 8))
    Select Case True
        Case Left$(result, 3) = "ok:"
        Case result = "no-selection": MsgBox "Select some text first.", vbExclamation, TITLE
        Case result = "no-document": MsgBox "Open a document first.", vbExclamation, TITLE
        Case Else: MsgBox "Could not mark the selection: " & Mid$(result, 7), vbExclamation, TITLE
    End Select
End Sub
