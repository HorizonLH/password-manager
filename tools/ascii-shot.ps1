# Renders a screenshot as a coarse character map so the layout can be reviewed
# from a terminal. Luminance is normalised across the capture, which is what
# makes the (subtle) card surfaces of the dark theme visible.
#
#   pwsh tools/ascii-shot.ps1 -Path shot.png -Cols 100 -Rows 30
#
# Legend: ' ' = brightest surface, '@' = darkest surface, 'B' = accent colour.

param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$Cols = 100,
  [int]$Rows = 30
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$bitmap = [System.Drawing.Bitmap]::FromFile($Path)
try {
  $cellWidth = [double]$bitmap.Width / $Cols
  $cellHeight = [double]$bitmap.Height / $Rows
  $cells = New-Object 'double[,]' $Rows, $Cols
  $accents = New-Object 'bool[,]' $Rows, $Cols
  $min = 1.0
  $max = 0.0

  for ($row = 0; $row -lt $Rows; $row++) {
    for ($col = 0; $col -lt $Cols; $col++) {
      $sum = 0.0
      $samples = 0
      $accentHits = 0
      # 3x3 samples per cell keeps text from dominating the average.
      for ($sy = 0; $sy -lt 3; $sy++) {
        for ($sx = 0; $sx -lt 3; $sx++) {
          $x = [Math]::Min($bitmap.Width - 1, [int](($col + ($sx + 0.5) / 3.0) * $cellWidth))
          $y = [Math]::Min($bitmap.Height - 1, [int](($row + ($sy + 0.5) / 3.0) * $cellHeight))
          $pixel = $bitmap.GetPixel($x, $y)
          $sum += (0.299 * $pixel.R + 0.587 * $pixel.G + 0.114 * $pixel.B) / 255
          if (($pixel.B - $pixel.R) -gt 50 -and $pixel.B -gt 110) { $accentHits++ }
          $samples++
        }
      }
      $value = $sum / $samples
      $cells[$row, $col] = $value
      $accents[$row, $col] = $accentHits -ge 4
      if ($value -lt $min) { $min = $value }
      if ($value -gt $max) { $max = $value }
    }
  }

  $ramp = " .:-=+*#%@"
  $span = [Math]::Max(0.0001, $max - $min)
  "capture $($bitmap.Width)x$($bitmap.Height) -> ${Cols}x${Rows} cells, luminance $([Math]::Round($min,3))..$([Math]::Round($max,3))"
  for ($row = 0; $row -lt $Rows; $row++) {
    $line = ""
    for ($col = 0; $col -lt $Cols; $col++) {
      $position = ($cells[$row, $col] - $min) / $span   # 0 = darkest, 1 = brightest
      $index = [int][Math]::Round((1 - $position) * ($ramp.Length - 1))
      $char = $ramp[[Math]::Max(0, [Math]::Min($ramp.Length - 1, $index))]
      if ($accents[$row, $col]) { $char = "B" }
      $line += $char
    }
    $line
  }
} finally {
  $bitmap.Dispose()
}
