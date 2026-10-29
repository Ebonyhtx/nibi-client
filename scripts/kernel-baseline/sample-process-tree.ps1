param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [int]$IntervalMs = 1000,
  [int]$DurationMs = 60000
)

# 阶段 0 基线：只读采集进程树 RSS/私有内存。不修改任何进程、不注入参数。
# 输出：每行一个 JSON（ts + processes 数组），由 collect-kernel-baseline.mjs 消费。

$deadline = (Get-Date).AddMilliseconds($DurationMs)
while ((Get-Date) -lt $deadline) {
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $byParent = @{}
  foreach ($process in $all) {
    $parent = [int]$process.ParentProcessId
    if (-not $byParent.ContainsKey($parent)) {
      $byParent[$parent] = New-Object System.Collections.ArrayList
    }
    [void]$byParent[$parent].Add($process)
  }

  $ids = New-Object System.Collections.Generic.HashSet[int]
  [void]$ids.Add($RootPid)
  $queue = New-Object System.Collections.Generic.Queue[int]
  $queue.Enqueue($RootPid)
  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    if ($byParent.ContainsKey($current)) {
      foreach ($child in $byParent[$current]) {
        $childId = [int]$child.ProcessId
        if ($ids.Add($childId)) { $queue.Enqueue($childId) }
      }
    }
  }

  $rows = @()
  foreach ($id in $ids) {
    $process = $all | Where-Object { [int]$_.ProcessId -eq $id } | Select-Object -First 1
    if (-not $process) { continue }
    $live = Get-Process -Id $id -ErrorAction SilentlyContinue
    $rows += [ordered]@{
      pid                = $id
      parentPid          = [int]$process.ParentProcessId
      name               = [string]$process.Name
      commandLine        = [string]$process.CommandLine
      createdAt          = if ($process.CreationDate) { $process.CreationDate.ToString("o") } else { $null }
      workingSetBytes    = if ($live) { [int64]$live.WorkingSet64 } else { $null }
      privateBytes       = if ($live) { [int64]$live.PrivateMemorySize64 } else { $null }
      pagedMemoryBytes   = if ($live) { [int64]$live.PagedMemorySize64 } else { $null }
      threadCount        = if ($live) { [int]$live.Threads.Count } else { $null }
      handleCount        = if ($live) { [int]$live.HandleCount } else { $null }
      cpuSeconds         = if ($live) { [math]::Round($live.CPU, 3) } else { $null }
    }
  }

  $payload = [ordered]@{
    ts       = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    rootPid  = $RootPid
    processes = $rows
  }
  Write-Output ($payload | ConvertTo-Json -Depth 5 -Compress)
  Start-Sleep -Milliseconds $IntervalMs
}
