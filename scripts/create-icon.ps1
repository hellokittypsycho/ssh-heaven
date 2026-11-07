# Regenerate checked-in PNG/ICO assets on Windows from the logo's vector commands.
Add-Type -AssemblyName System.Drawing
$assetDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\build'))
[System.IO.Directory]::CreateDirectory($assetDirectory) | Out-Null
$bitmap = [System.Drawing.Bitmap]::new(256, 256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)
function New-RoundedPath([float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
  $shape = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $radius * 2
  $shape.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $shape.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $shape.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $shape.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $shape.CloseFigure()
  return $shape
}
$outer = New-RoundedPath 8 8 240 240 55
$inner = New-RoundedPath 53 66 150 128 12
$brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new([System.Drawing.Rectangle]::new(8,8,240,240), [System.Drawing.ColorTranslator]::FromHtml('#214f41'), [System.Drawing.ColorTranslator]::FromHtml('#102920'), 45)
$border = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#438f77'), 3)
$ink = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#85e2bf'), 8)
$ink.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$ink.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$ink.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$graphics.FillPath($brush, $outer)
$graphics.DrawPath($border, $outer)
$graphics.DrawPath($ink, $inner)
$graphics.DrawLines($ink, [System.Drawing.PointF[]]@([System.Drawing.PointF]::new(83,108), [System.Drawing.PointF]::new(105,128), [System.Drawing.PointF]::new(83,148)))
$graphics.DrawLine($ink, 126, 148, 164, 148)
$bitmap.Save((Join-Path $assetDirectory 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes = [System.IO.File]::ReadAllBytes((Join-Path $assetDirectory 'icon.png'))
$writer = [System.IO.BinaryWriter]::new([System.IO.File]::Create((Join-Path $assetDirectory 'icon.ico')))
try {
  $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
  $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
  $writer.Write([uint16]1); $writer.Write([uint16]32)
  $writer.Write([uint32]$pngBytes.Length); $writer.Write([uint32]22); $writer.Write($pngBytes)
} finally {
  $writer.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
  $outer.Dispose(); $inner.Dispose(); $brush.Dispose(); $border.Dispose(); $ink.Dispose()
}
