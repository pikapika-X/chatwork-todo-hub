Add-Type -AssemblyName System.Drawing
$dir = 'C:\Users\User\.claude\チャットワーク連携\chatwork-hub-web'

function New-Icon([int]$S, [string]$out) {
  $bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # メタリックな黒い円（中心を少し明るく＝球体っぽい光沢）
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse(($S*0.024), ($S*0.024), ($S*0.952), ($S*0.952))
  $pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($path)
  $pgb.CenterPoint = New-Object System.Drawing.PointF(($S*0.40), ($S*0.34))
  $pgb.CenterColor = [System.Drawing.Color]::FromArgb(255, 104, 110, 120)
  $pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(255, 6, 7, 9))
  $g.FillPath($pgb, $path)

  # 上部の光沢
  $gloss = New-Object System.Drawing.Drawing2D.GraphicsPath
  $gloss.AddEllipse(($S*0.20), ($S*0.10), ($S*0.60), ($S*0.40))
  $gb = New-Object System.Drawing.Drawing2D.PathGradientBrush($gloss)
  $gb.CenterColor = [System.Drawing.Color]::FromArgb(120, 255, 255, 255)
  $gb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 255, 255))
  $g.FillPath($gb, $gloss)

  # 金属リム
  $rim = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(180, 150, 158, 168), ($S*0.0172))
  $g.DrawEllipse($rim, ($S*0.024), ($S*0.024), ($S*0.952), ($S*0.952))

  # 白抜きのピラミッドマーク
  $T = New-Object System.Drawing.PointF(($S*0.50), ($S*0.20))
  $L = New-Object System.Drawing.PointF(($S*0.22), ($S*0.60))
  $R = New-Object System.Drawing.PointF(($S*0.78), ($S*0.60))
  $B = New-Object System.Drawing.PointF(($S*0.50), ($S*0.82))
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, ($S*0.0547))
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pts = [System.Drawing.PointF[]]@($T, $L, $B, $R, $T)
  $g.DrawLines($pen, $pts)
  $g.DrawLine($pen, $T, $B)

  $g.Dispose()
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("wrote " + $out + " (" + $S + "px)")
}

New-Icon 192 (Join-Path $dir 'icon-192.png')
New-Icon 512 (Join-Path $dir 'icon-512.png')
New-Icon 180 (Join-Path $dir 'apple-touch-icon.png')
