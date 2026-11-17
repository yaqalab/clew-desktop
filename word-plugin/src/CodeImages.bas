Attribute VB_Name = "CodeImages"
' Small colour squares for codes in the ribbon's menus. Word's ribbon takes a picture object,
' which LoadPicture makes from a file: each colour is written once as a 16 x 16 bitmap in the
' temp folder (%TEMP%\yaqatw-colors\RRGGBB.bmp), with a grey edge so white and pale ones show.
Option Explicit

Private Const SQUARE As Long = 16

' The picture for "#RRGGBB", or Nothing.
Public Function ColorPicture(ByVal colorValue As Variant) As Object
    Dim code As String
    Dim folder As String
    Dim file As String
    On Error GoTo Failed
    code = UCase$(Replace(Trim$(CStr(colorValue)), "#", ""))
    If Len(code) <> 6 Then Exit Function
    If Not code Like "[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]" Then Exit Function
    folder = Environ$("TEMP") & "\yaqatw-colors"
    If Len(Dir$(folder, vbDirectory)) = 0 Then MkDir folder
    file = folder & "\" & code & ".bmp"
    If Len(Dir$(file)) = 0 Then
        WriteSquare file, CLng("&H" & Mid$(code, 1, 2)), CLng("&H" & Mid$(code, 3, 2)), CLng("&H" & Mid$(code, 5, 2))
    End If
    Set ColorPicture = LoadPicture(file)
    Exit Function
Failed:
    Set ColorPicture = Nothing
End Function

' A 24-bit bitmap: rows of 16 x 3 = 48 bytes, already a multiple of 4 (no padding).
Private Sub WriteSquare(ByVal file As String, ByVal r As Long, ByVal g As Long, ByVal b As Long)
    Dim bytes() As Byte
    Dim total As Long
    Dim x As Long
    Dim y As Long
    Dim p As Long
    Dim f As Integer
    total = 54 + SQUARE * SQUARE * 3
    ReDim bytes(0 To total - 1)
    bytes(0) = 66 ' B
    bytes(1) = 77 ' M
    PutLong bytes, 2, total
    PutLong bytes, 10, 54
    PutLong bytes, 14, 40
    PutLong bytes, 18, SQUARE
    PutLong bytes, 22, SQUARE
    bytes(26) = 1
    bytes(28) = 24
    PutLong bytes, 34, SQUARE * SQUARE * 3
    p = 54
    For y = 0 To SQUARE - 1
        For x = 0 To SQUARE - 1
            If x = 0 Or y = 0 Or x = SQUARE - 1 Or y = SQUARE - 1 Then
                bytes(p) = 128
                bytes(p + 1) = 128
                bytes(p + 2) = 128
            Else
                bytes(p) = b
                bytes(p + 1) = g
                bytes(p + 2) = r
            End If
            p = p + 3
        Next x
    Next y
    f = FreeFile
    Open file For Binary Access Write As #f
    Put #f, 1, bytes
    Close #f
End Sub

Private Sub PutLong(bytes() As Byte, ByVal at As Long, ByVal value As Long)
    bytes(at) = value And &HFF
    bytes(at + 1) = (value \ &H100) And &HFF
    bytes(at + 2) = (value \ &H10000) And &HFF
    bytes(at + 3) = (value \ &H1000000) And &HFF
End Sub
