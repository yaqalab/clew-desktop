Attribute VB_Name = "Ribbon"
' The Yaqatw tab's buttons (customUI/customUI14.xml). Only these talk to the user.
' `control` is an IRibbonControl, typed Object so no extra library reference is needed.
Option Explicit

Private Const TITLE As String = "Yaqatw"
Private Const NOT_RUNNING As String = "Clew Desktop is not running. Start it, then try again."

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
