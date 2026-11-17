Attribute VB_Name = "Uuid"
' Random UUIDs for new highlights, as crypto.randomUUID() makes them in yaqatw.
Option Explicit

Private Type GUID_T
    Data1 As Long
    Data2 As Integer
    Data3 As Integer
    Data4(0 To 7) As Byte
End Type

Private Declare PtrSafe Function CoCreateGuid Lib "ole32" (ByRef id As GUID_T) As Long

' A random UUID, lower case.
Public Function NewUuid() As String
    Dim g As GUID_T
    Dim s As String
    Dim i As Long
    If CoCreateGuid(g) <> 0 Then Err.Raise vbObjectError + 1, "Uuid.NewUuid", "CoCreateGuid failed"
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
