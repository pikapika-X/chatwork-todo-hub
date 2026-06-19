Add-Type -AssemblyName System.Drawing
$dir = 'C:\Users\User\.claude\チャットワーク連携\chatwork-hub-web'

# HSV(0-360, 0-1, 0-1) -> System.Drawing.Color
function Hsv2Rgb([double]$h, [double]$s, [double]$v) {
  $h = $h % 360; if ($h -lt 0) { $h += 360 }
  $c = $v * $s
  $x = $c * (1 - [math]::Abs((($h / 60) % 2) - 1))
  $m = $v - $c
  switch ([math]::Floor($h / 60)) {
    0 { $r = $c; $g2 = $x; $b = 0 }
    1 { $r = $x; $g2 = $c; $b = 0 }
    2 { $r = 0; $g2 = $c; $b = $x }
    3 { $r = 0; $g2 = $x; $b = $c }
    4 { $r = $x; $g2 = 0; $b = $c }
    default { $r = $c; $g2 = 0; $b = $x }
  }
  return [System.Drawing.Color]::FromArgb(255, [int](($r + $m) * 255), [int](($g2 + $m) * 255), [int](($b + $m) * 255))
}

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

  # 虹色のリム（縁取り）— 円周に沿って色相を一周させる
  $rx = $S * 0.030; $ry = $S * 0.030; $rw2 = $S * 0.940
  $rimWidth = $S * 0.052
  $segs = 240
  $step = 360.0 / $segs
  for ($i = 0; $i -lt $segs; $i++) {
    $hue = ($i / $segs) * 360.0
    $col = Hsv2Rgb $hue 0.95 1.0
    $p = New-Object System.Drawing.Pen($col, $rimWidth)
    # 隙間が出ないよう少し重ねて描く
    $g.DrawArc($p, $rx, $ry, $rw2, $rw2, ($i * $step), ($step + 0.9))
    $p.Dispose()
  }

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
New-Icon 128 (Join-Path $dir 'favicon.png')
