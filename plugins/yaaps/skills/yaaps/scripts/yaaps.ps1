[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $true)]
    [string]$Command,
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$CommandArguments
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Json($Value) {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $Value -Compress -Depth 30))
}

function Fail([string]$Message) {
    [Console]::Error.WriteLine("YAAPS: $Message")
    exit 1
}

function Parse-Options([string[]]$Values, [string[]]$Flags, [string[]]$ValueOptions) {
    $result = @{ Positionals = [System.Collections.ArrayList]@() }
    for ($index = 0; $index -lt $Values.Count; $index++) {
        $value = $Values[$index]
        if ($value.StartsWith('--')) {
            $name = $value.Substring(2)
            if ($Flags -contains $name) {
                $result[$name] = $true
                continue
            }
            if ($ValueOptions -notcontains $name) { Fail "Unknown option: $value" }
            if ($index + 1 -ge $Values.Count) { Fail "$value requires a value." }
            $index++
            $result[$name] = $Values[$index]
        } else {
            [void]$result.Positionals.Add($value)
        }
    }
    return $result
}

function Get-RequiredOption($Options, [string]$Name) {
    if (-not $Options.ContainsKey($Name) -or [string]::IsNullOrWhiteSpace($Options[$Name])) {
        Fail "--$Name is required."
    }
    return [string]$Options[$Name]
}

function Normalize-Origin([string]$Value) {
    try { $uri = [Uri]$Value } catch { Fail 'The service URL is invalid.' }
    if (($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https') -or
        -not [string]::IsNullOrEmpty($uri.UserInfo) -or
        $uri.AbsolutePath -ne '/' -or
        -not [string]::IsNullOrEmpty($uri.Query) -or
        -not [string]::IsNullOrEmpty($uri.Fragment)) {
        Fail 'The service URL must be a bare HTTP or HTTPS origin.'
    }
    return $uri.GetLeftPart([UriPartial]::Authority)
}

function Assert-DraftId([string]$Value) {
    if ($Value -notmatch '^[A-Za-z0-9_-]{32}$') { Fail 'The draft ID format is invalid.' }
    return $Value
}

function Get-ConfigDirectory {
    if (-not [string]::IsNullOrWhiteSpace($env:YAAPS_CONFIG_DIR)) {
        return [IO.Path]::GetFullPath($env:YAAPS_CONFIG_DIR)
    }
    $userHome = $env:HOME
    if ([string]::IsNullOrWhiteSpace($userHome)) {
        $userHome = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    }
    if ([string]::IsNullOrWhiteSpace($userHome)) { Fail 'A home directory could not be resolved.' }
    return [IO.Path]::Combine($userHome, '.yaaps')
}

function Read-Config {
    $path = [IO.Path]::Combine((Get-ConfigDirectory), 'config.json')
    if (-not [IO.File]::Exists($path)) {
        # Read-only fallback to the YAAPS CLI's config so connecting with
        # either tool is enough; this helper still writes only its own store.
        $cliPath = $null
        if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
            $cliPath = [IO.Path]::Combine($env:APPDATA, 'YAAPS', 'config.json')
        }
        if ($cliPath -and [IO.File]::Exists($cliPath)) {
            try { return (Get-Content -LiteralPath $cliPath -Raw -Encoding UTF8 | ConvertFrom-Json) }
            catch { return [pscustomobject]@{ version = 1 } }
        }
        return [pscustomobject]@{ version = 1 }
    }
    try { return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json) }
    catch { Fail 'The YAAPS configuration is invalid.' }
}

function Write-Config([string]$ApiUrl, [string]$ApiKey) {
    $directory = Get-ConfigDirectory
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $destination = [IO.Path]::Combine($directory, 'config.json')
    $temporary = [IO.Path]::Combine($directory, ('.config-' + [Guid]::NewGuid().ToString('N') + '.tmp'))
    try {
        $document = [ordered]@{ version = 1; apiUrl = $ApiUrl; apiKey = $ApiKey }
        [IO.File]::WriteAllText($temporary, ((ConvertTo-Json $document -Depth 5) + "`n"), (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temporary -Destination $destination -Force
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Get-Credentials {
    $config = Read-Config
    $apiUrl = if (-not [string]::IsNullOrWhiteSpace($env:YAAPS_API_URL)) { $env:YAAPS_API_URL } else { $config.apiUrl }
    $apiKey = if (-not [string]::IsNullOrWhiteSpace($env:YAAPS_API_KEY)) { $env:YAAPS_API_KEY } else { $config.apiKey }
    if ([string]::IsNullOrWhiteSpace($apiUrl) -or [string]::IsNullOrWhiteSpace($apiKey)) {
        Fail 'Credentials are missing. Run connect first.'
    }
    if ($apiKey -notmatch '^yaaps_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$') { Fail 'The stored API key is invalid.' }
    return @{ ApiUrl = (Normalize-Origin $apiUrl); ApiKey = [string]$apiKey }
}

function Invoke-Request([string]$Method, [string]$Url, [string]$ApiKey, $JsonBody, [string]$File, [switch]$Tolerant) {
    $parameters = @{
        ErrorAction = 'Stop'
        MaximumRedirection = 0
        Method = $Method
        TimeoutSec = 60
        Uri = $Url
    }
    if (-not [string]::IsNullOrEmpty($ApiKey)) {
        $parameters.Headers = @{ Authorization = "Bearer $ApiKey" }
    }
    if ($null -ne $JsonBody) {
        $parameters.Body = ConvertTo-Json -InputObject $JsonBody -Compress -Depth 10
        $parameters.ContentType = 'application/json; charset=utf-8'
    }
    if (-not [string]::IsNullOrEmpty($File)) {
        $parameters.InFile = $File
        $parameters.ContentType = 'text/html; charset=utf-8'
    }
    try { return Invoke-RestMethod @parameters }
    catch {
        if ($Tolerant) { return $null }
        $detail = $_.Exception.Message
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $detail = $_.ErrorDetails.Message }
        Fail "request failed: $detail"
    }
}

function New-ApiKey {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    $secret = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $prefixBytes = New-Object byte[] 8
    $prefixGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $prefixGenerator.GetBytes($prefixBytes) } finally { $prefixGenerator.Dispose() }
    $prefix = 'yaaps_' + [Convert]::ToBase64String($prefixBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_').Substring(0, 10)
    $key = $prefix + '_' + $secret
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($key)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    return @{ Hash = $hash; Key = $key; Prefix = $prefix }
}

function Encode([string]$Value) { return [Uri]::EscapeDataString($Value) }

try {
    switch ($Command.ToLowerInvariant()) {
        'connect' {
            $options = Parse-Options $CommandArguments @('no-open') @('api-url', 'label')
            $requestedUrl = if ($options.ContainsKey('api-url')) { [string]$options.'api-url' } else { 'https://yaaps.net' }
            $apiUrl = Normalize-Origin $requestedUrl
            if ($apiUrl -match '^http://' -and $apiUrl -notmatch '^http://(localhost|127\.0\.0\.1)(:|$)') {
                [Console]::Error.WriteLine('YAAPS: warning: plain HTTP sends the API key in cleartext; use HTTPS outside localhost.')
            }
            $label = if ($options.ContainsKey('label')) { [string]$options.label } else { 'YAAPS Skill on ' + [Environment]::MachineName }
            if ([string]::IsNullOrWhiteSpace($label) -or $label.Length -gt 100) { Fail 'The connection label must be 1 to 100 characters.' }
            $generated = New-ApiKey
            $connection = Invoke-Request 'Post' "$apiUrl/auth/device-connections" '' @{
                keyHash = $generated.Hash
                keyPrefix = $generated.Prefix
                label = $label
            } ''
            Write-Json ([ordered]@{
                status = 'pending'
                verificationUrl = $connection.verificationUrlComplete
                userCode = $connection.userCode
                expiresAt = $connection.expiresAt
            })
            if (-not $options.ContainsKey('no-open')) {
                $verificationUrl = [string]$connection.verificationUrlComplete
                $openUrl = $null
                try {
                    $candidate = [Uri]$verificationUrl
                    if (($candidate.Scheme -eq 'http' -or $candidate.Scheme -eq 'https') -and
                        $verificationUrl.StartsWith("$apiUrl/", [StringComparison]::Ordinal)) {
                        $openUrl = $verificationUrl
                    }
                } catch { $openUrl = $null }
                if ($null -eq $openUrl) {
                    [Console]::Error.WriteLine('YAAPS: refusing to open an unexpected verification URL; open it manually from the pending output.')
                } else {
                    try { Start-Process $openUrl | Out-Null }
                    catch { [Console]::Error.WriteLine('YAAPS: could not open the browser; open the verification URL manually.') }
                }
            }
            # ConvertFrom-Json may return expiresAt as DateTime; reparsing its
            # culture-formatted string form fails on non en-US locales.
            $expiresRaw = $connection.expiresAt
            $expires = if ($expiresRaw -is [DateTimeOffset]) { $expiresRaw }
                elseif ($expiresRaw -is [DateTime]) { [DateTimeOffset]$expiresRaw }
                else { [DateTimeOffset]::Parse([string]$expiresRaw, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) }
            while ([DateTimeOffset]::UtcNow -lt $expires) {
                Start-Sleep -Seconds ([Math]::Max(1, [int]$connection.intervalSeconds))
                $decision = Invoke-Request 'Post' "$apiUrl/auth/device-connections/token" '' @{ deviceSecret = $connection.deviceSecret } '' -Tolerant
                if ($null -eq $decision -or $decision.status -eq 'pending') { continue }
                if ($decision.status -eq 'denied') { Fail 'The connection request was denied.' }
                if ($decision.status -eq 'approved') {
                    Write-Config $apiUrl $generated.Key
                    Write-Json ([ordered]@{ status = 'approved'; apiUrl = $apiUrl; apiKeyPrefix = $generated.Prefix; apiKeyId = $decision.apiKeyId })
                    exit 0
                }
                Fail 'The connection response was invalid.'
            }
            Fail 'The connection request expired.'
        }
        'config' {
            if ($CommandArguments.Count -ne 1 -or $CommandArguments[0] -ne 'show') { Fail 'Usage: config show' }
            $config = Read-Config
            $prefix = $null
            if (-not [string]::IsNullOrWhiteSpace($config.apiKey) -and $config.apiKey.Length -ge 16) { $prefix = $config.apiKey.Substring(0, 16) }
            Write-Json ([ordered]@{ apiUrl = $config.apiUrl; apiKeyPrefix = $prefix })
        }
        'status' {
            $options = Parse-Options $CommandArguments @() @('api-url')
            $config = Read-Config
            $candidate = if ($options.ContainsKey('api-url')) { $options.'api-url' } elseif (-not [string]::IsNullOrWhiteSpace($env:YAAPS_API_URL)) { $env:YAAPS_API_URL } else { $config.apiUrl }
            if ([string]::IsNullOrWhiteSpace($candidate)) { $candidate = 'https://yaaps.net' }
            $apiUrl = Normalize-Origin $candidate
            $health = Invoke-Request 'Get' "$apiUrl/healthz" '' $null ''
            $readiness = Invoke-Request 'Get' "$apiUrl/readyz" '' $null ''
            Write-Json ([ordered]@{ health = $health; readiness = $readiness })
        }
        'publish' {
            $options = Parse-Options $CommandArguments @() @('category', 'draft-id', 'mode', 'title', 'ttl')
            if ($options.Positionals.Count -ne 1) { Fail 'Usage: publish <html-file> [--mode isolated|connected] [--category <name>] [--draft-id <id>] [--title <title>] [--ttl <seconds>]' }
            $file = [IO.Path]::GetFullPath([string]$options.Positionals[0])
            if (-not [IO.File]::Exists($file)) { Fail 'The HTML file does not exist.' }
            $resourcePolicy = if ($options.ContainsKey('mode')) { [string]$options.mode } else { 'isolated' }
            if ($resourcePolicy -notin @('isolated', 'connected')) { Fail '--mode must be either isolated or connected.' }
            $credentials = Get-Credentials
            $route = '/api/drafts'
            if ($options.ContainsKey('draft-id')) { $route += '/' + (Assert-DraftId $options.'draft-id') + '/versions' }
            $query = [System.Collections.ArrayList]@()
            [void]$query.Add('resourcePolicy=' + $resourcePolicy)
            if ($options.ContainsKey('category')) { [void]$query.Add('category=' + (Encode $options.category)) }
            if ($options.ContainsKey('title')) { [void]$query.Add('title=' + (Encode $options.title)) }
            if ($options.ContainsKey('ttl')) {
                $ttl = 0
                if (-not [int]::TryParse($options.ttl, [ref]$ttl) -or $ttl -le 0) { Fail '--ttl must be a positive integer.' }
                [void]$query.Add('ttlSeconds=' + $ttl)
            }
            if ($query.Count -gt 0) { $route += '?' + ($query -join '&') }
            Write-Json (Invoke-Request 'Post' ($credentials.ApiUrl + $route) $credentials.ApiKey $null $file)
        }
        'list' {
            $options = Parse-Options $CommandArguments @() @('category', 'limit', 'offset')
            $limit = if ($options.ContainsKey('limit')) { [int]$options.limit } else { 50 }
            $offset = if ($options.ContainsKey('offset')) { [int]$options.offset } else { 0 }
            $route = "/api/drafts?limit=$limit&offset=$offset"
            if ($options.ContainsKey('category')) { $route += '&category=' + (Encode $options.category) }
            $credentials = Get-Credentials
            Write-Json (Invoke-Request 'Get' ($credentials.ApiUrl + $route) $credentials.ApiKey $null '')
        }
        'inspect' {
            $options = Parse-Options $CommandArguments @() @()
            if ($options.Positionals.Count -ne 1) { Fail 'Usage: inspect <draft-id>' }
            $id = Assert-DraftId $options.Positionals[0]
            $credentials = Get-Credentials
            $draft = Invoke-Request 'Get' ($credentials.ApiUrl + "/api/drafts/$id") $credentials.ApiKey $null ''
            $versions = Invoke-Request 'Get' ($credentials.ApiUrl + "/api/drafts/$id/versions?limit=100&offset=0") $credentials.ApiKey $null ''
            Write-Json ([ordered]@{ draft = $draft; versions = $versions })
        }
        'categorize' {
            $options = Parse-Options $CommandArguments @('clear') @()
            if ($options.Positionals.Count -lt 1 -or $options.Positionals.Count -gt 2) {
                Fail 'Usage: categorize <draft-id> <category> | categorize <draft-id> --clear'
            }
            $id = Assert-DraftId $options.Positionals[0]
            $clear = $options.ContainsKey('clear')
            $hasCategory = $options.Positionals.Count -eq 2
            if ($clear -and $hasCategory) { Fail 'A category and --clear cannot be used together.' }
            if (-not $clear -and -not $hasCategory) { Fail 'Provide a category or --clear.' }
            $body = if ($clear) { @{ category = $null } } else { @{ category = [string]$options.Positionals[1] } }
            $credentials = Get-Credentials
            Write-Json (Invoke-Request 'Patch' ($credentials.ApiUrl + "/api/drafts/$id") $credentials.ApiKey $body '')
        }
        { $_ -eq 'disable' -or $_ -eq 'enable' } {
            $options = Parse-Options $CommandArguments @() @()
            if ($options.Positionals.Count -ne 1) { Fail "Usage: $Command <draft-id>" }
            $id = Assert-DraftId $options.Positionals[0]
            $credentials = Get-Credentials
            $status = if ($Command.ToLowerInvariant() -eq 'disable') { 'disabled' } else { 'enabled' }
            Write-Json (Invoke-Request 'Patch' ($credentials.ApiUrl + "/api/drafts/$id") $credentials.ApiKey @{ status = $status } '')
        }
        'delete' {
            $options = Parse-Options $CommandArguments @() @('confirm')
            if ($options.Positionals.Count -ne 1) { Fail 'Usage: delete <draft-id> --confirm <draft-id>' }
            $id = Assert-DraftId $options.Positionals[0]
            if (-not $options.ContainsKey('confirm') -or $options.confirm -ne $id) { Fail 'The confirmation draft ID does not match.' }
            $credentials = Get-Credentials
            [void](Invoke-Request 'Delete' ($credentials.ApiUrl + "/api/drafts/$id") $credentials.ApiKey $null '')
            Write-Json ([ordered]@{ deleted = $id })
        }
        default { Fail 'Unknown command. Use connect, config show, status, publish, list, inspect, categorize, disable, enable, or delete.' }
    }
} catch {
    Fail $_.Exception.Message
}
