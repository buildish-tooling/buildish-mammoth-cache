#
# Copyright 2026 The Apache Software Foundation
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Locates gpg.exe on the Windows runner, adds its parent directory to the
# GitHub Actions PATH, and sets BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND so
# the action uses the discovered binary directly.

$candidates = [System.Collections.Generic.List[string]]::new()
$discoveredCommands = Get-Command gpg.exe -All -ErrorAction SilentlyContinue
foreach ($discoveredCommand in $discoveredCommands) {
  if ($null -ne $discoveredCommand -and -not [string]::IsNullOrWhiteSpace($discoveredCommand.Source)) {
    $candidates.Add($discoveredCommand.Source)
  }
}
foreach ($candidate in @(
  'C:\Program Files\GnuPG\bin\gpg.exe',
  'C:\Program Files (x86)\GnuPG\bin\gpg.exe',
  'C:\Program Files\Git\mingw64\bin\gpg.exe',
  'C:\Program Files\Git\usr\bin\gpg.exe'
)) {
  $candidates.Add($candidate)
}

$gpgPath = $candidates |
  Where-Object { Test-Path -LiteralPath $_ } |
  Select-Object -Unique -First 1
if ([string]::IsNullOrWhiteSpace($gpgPath)) {
  throw 'No gpg.exe was found on the Windows runner in the expected Git or GnuPG locations.'
}

Split-Path -Parent $gpgPath | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
"BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND=$gpgPath" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
& $gpgPath --version

