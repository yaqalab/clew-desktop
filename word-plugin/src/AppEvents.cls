VERSION 1.0 CLASS
BEGIN
  MultiUse = -1  'True
END
Attribute VB_Name = "AppEvents"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = False
Attribute VB_Exposed = False
' Word's application events: the selection, for the sessions with Clew Desktop (Bridge.bas;
' nothing for documents without one), and the document in front, for the ribbon's groups
' (Ribbon.bas). Set up when the ribbon loads.
Option Explicit

Public WithEvents App As Word.Application
Attribute App.VB_VarHelpID = -1

Private Sub App_WindowSelectionChange(ByVal Sel As Selection)
    BridgeSelectionChanged Sel
End Sub

Private Sub App_WindowActivate(ByVal Doc As Document, ByVal Wn As Window)
    BridgeKeepTicking
    RibbonRefresh
End Sub

Private Sub App_DocumentChange()
    RibbonRefresh
End Sub
