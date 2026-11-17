Attribute VB_Name = "Json"
' JSON for talking to Clew Desktop.
'
' JsonParse reads any JSON: objects become Collections keyed by name (JsonGet reads them),
' arrays Variant arrays (0-based), strings Strings, numbers Doubles, true/false Booleans, null
' Null. Strings are cut out in runs (InStr + Mid$) and joined once, so megabyte XML parts stay
' fast. JsonEscape escapes with Replace, for the same reason.
'
' Arguments of public functions are Variants: Application.Run passes them so (from a test, or
' from another template), and a String parameter would refuse them.
Option Explicit

Private src As String
Private pos As Long
Private srcLen As Long

' ----------------------------------------------------------------------------------------------
' Writing

Public Function JsonEscape(ByVal value As Variant) As String
    Dim s As String
    Dim i As Long
    s = CStr(value)
    s = Replace(s, "\", "\\")
    s = Replace(s, """", "\""")
    s = Replace(s, vbCr, "\r")
    s = Replace(s, vbLf, "\n")
    s = Replace(s, vbTab, "\t")
    For i = 0 To 31
        If InStr(1, s, Chr$(i), vbBinaryCompare) > 0 Then s = Replace(s, Chr$(i), "\u" & Right$("000" & Hex$(i), 4))
    Next i
    JsonEscape = s
End Function

' A JSON string literal.
Public Function JsonStr(ByVal value As Variant) As String
    JsonStr = """" & JsonEscape(value) & """"
End Function

' A JSON array of strings from a Variant array (or "[]").
Public Function JsonStrArray(items As Variant) As String
    Dim i As Long
    Dim parts() As String
    If Not IsArray(items) Then
        JsonStrArray = "[]"
        Exit Function
    End If
    If UBound(items) < LBound(items) Then
        JsonStrArray = "[]"
        Exit Function
    End If
    ReDim parts(LBound(items) To UBound(items))
    For i = LBound(items) To UBound(items)
        parts(i) = JsonStr(items(i))
    Next i
    JsonStrArray = "[" & Join(parts, ",") & "]"
End Function

' ----------------------------------------------------------------------------------------------
' Reading

Public Function JsonParse(ByVal text As Variant) As Variant
    src = CStr(text)
    pos = 1
    srcLen = Len(src)
    Dim v As Variant
    ReadValue v
    SkipSpace
    If pos <= srcLen Then Fail "unexpected text after the value"
    If IsObject(v) Then Set JsonParse = v Else JsonParse = v
    src = ""
End Function

' obj("key"), or `fallback` when obj is not an object or has no such key.
Public Function JsonGet(obj As Variant, ByVal key As Variant, Optional ByVal fallback As Variant) As Variant
    If IsMissing(fallback) Then fallback = Null
    If Not IsObject(obj) Then GoTo Missing
    If obj Is Nothing Then GoTo Missing
    On Error GoTo Missing
    If IsObject(obj.Item(CStr(key))) Then
        Set JsonGet = obj.Item(CStr(key))
    Else
        JsonGet = obj.Item(CStr(key))
    End If
    Exit Function
Missing:
    JsonGet = fallback
End Function

Public Function JsonHas(obj As Variant, ByVal key As Variant) As Boolean
    Dim v As Variant
    If Not IsObject(obj) Then Exit Function
    On Error GoTo Missing
    If IsObject(obj.Item(CStr(key))) Then Set v = obj.Item(CStr(key)) Else v = obj.Item(CStr(key))
    JsonHas = True
Missing:
End Function

' The string value of "key" in a flat JSON object, or "" when it is absent or not a string.
Public Function JsonString(ByVal jsonText As Variant, ByVal fieldName As Variant) As String
    Dim v As Variant
    On Error GoTo Bad
    v = JsonGet(JsonParse(jsonText), fieldName, "")
    If VarType(v) = vbString Then JsonString = v
Bad:
End Function

' The digits of a non-negative integer "key" in a flat JSON object, or "" when it is not one.
Public Function JsonDigits(ByVal jsonText As Variant, ByVal fieldName As Variant) As String
    Dim v As Variant
    On Error GoTo Bad
    v = JsonGet(JsonParse(jsonText), fieldName, "")
    If VarType(v) = vbDouble Then
        If v >= 0 And v = Int(v) And v < 2147483648# Then JsonDigits = CStr(CLng(v))
    End If
Bad:
End Function

Private Sub Fail(ByVal what As String)
    Err.Raise vbObjectError + 600, "Json", "JSON: " & what & " at " & pos
End Sub

Private Sub SkipSpace()
    Dim c As String
    Do While pos <= srcLen
        c = Mid$(src, pos, 1)
        If c <> " " And c <> vbTab And c <> vbCr And c <> vbLf Then Exit Do
        pos = pos + 1
    Loop
End Sub

Private Sub ReadValue(ByRef out As Variant)
    Dim c As String
    SkipSpace
    If pos > srcLen Then Fail "unexpected end"
    c = Mid$(src, pos, 1)
    Select Case c
        Case "{": Set out = ReadObject()
        Case "[": out = ReadArray()
        Case """": out = ReadString()
        Case "t": Expect "true": out = True
        Case "f": Expect "false": out = False
        Case "n": Expect "null": out = Null
        Case Else: out = ReadNumber()
    End Select
End Sub

Private Sub Expect(ByVal word As String)
    If Mid$(src, pos, Len(word)) <> word Then Fail "expected " & word
    pos = pos + Len(word)
End Sub

Private Function ReadObject() As Collection
    Dim obj As New Collection
    Dim key As String
    Dim v As Variant
    pos = pos + 1
    SkipSpace
    If Mid$(src, pos, 1) = "}" Then
        pos = pos + 1
        Set ReadObject = obj
        Exit Function
    End If
    Do
        SkipSpace
        If Mid$(src, pos, 1) <> """" Then Fail "expected a name"
        key = ReadString()
        SkipSpace
        If Mid$(src, pos, 1) <> ":" Then Fail "expected :"
        pos = pos + 1
        ReadValue v
        ' A repeated name: the last one wins.
        On Error Resume Next
        obj.Remove key
        On Error GoTo 0
        obj.Add v, key
        SkipSpace
        Select Case Mid$(src, pos, 1)
            Case ",": pos = pos + 1
            Case "}"
                pos = pos + 1
                Exit Do
            Case Else: Fail "expected , or }"
        End Select
    Loop
    Set ReadObject = obj
End Function

Private Function ReadArray() As Variant
    Dim items() As Variant
    Dim count As Long
    Dim v As Variant
    pos = pos + 1
    SkipSpace
    If Mid$(src, pos, 1) = "]" Then
        pos = pos + 1
        ReadArray = Array()
        Exit Function
    End If
    ReDim items(0 To 15)
    Do
        ReadValue v
        If count > UBound(items) Then ReDim Preserve items(0 To 2 * UBound(items) + 1)
        If IsObject(v) Then Set items(count) = v Else items(count) = v
        count = count + 1
        SkipSpace
        Select Case Mid$(src, pos, 1)
            Case ",": pos = pos + 1
            Case "]"
                pos = pos + 1
                Exit Do
            Case Else: Fail "expected , or ]"
        End Select
    Loop
    ReDim Preserve items(0 To count - 1)
    ReadArray = items
End Function

Private Function ReadString() As String
    Dim parts() As String
    Dim n As Long
    Dim q As Long
    Dim b As Long
    Dim e As String
    ReDim parts(0 To 15)
    pos = pos + 1
    Do
        q = InStr(pos, src, """")
        If q = 0 Then Fail "unterminated string"
        b = InStr(pos, src, "\")
        If b = 0 Or b > q Then
            AddPart parts, n, Mid$(src, pos, q - pos)
            pos = q + 1
            Exit Do
        End If
        AddPart parts, n, Mid$(src, pos, b - pos)
        e = Mid$(src, b + 1, 1)
        pos = b + 2
        Select Case e
            Case "n": AddPart parts, n, vbLf
            Case "r": AddPart parts, n, vbCr
            Case "t": AddPart parts, n, vbTab
            Case "b": AddPart parts, n, Chr$(8)
            Case "f": AddPart parts, n, Chr$(12)
            Case "u"
                AddPart parts, n, ChrW$(CLng("&H" & Mid$(src, pos, 4)))
                pos = pos + 4
            Case Else: AddPart parts, n, e
        End Select
    Loop
    ReDim Preserve parts(0 To n - 1)
    ReadString = Join(parts, "")
End Function

Private Sub AddPart(parts() As String, n As Long, ByVal s As String)
    If n > UBound(parts) Then ReDim Preserve parts(0 To 2 * UBound(parts) + 1)
    parts(n) = s
    n = n + 1
End Sub

Private Function ReadNumber() As Double
    Dim start As Long
    start = pos
    Do While pos <= srcLen
        If InStr(1, "+-0123456789.eE", Mid$(src, pos, 1)) = 0 Then Exit Do
        pos = pos + 1
    Loop
    If pos = start Then Fail "unexpected character"
    ' Val reads "." as the decimal point whatever the locale.
    ReadNumber = Val(Mid$(src, start, pos - start))
End Function
