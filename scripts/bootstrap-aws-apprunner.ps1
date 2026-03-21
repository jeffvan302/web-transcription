[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$GitHubOwner,

    [Parameter(Mandatory = $true)]
    [string]$GitHubRepo,

    [string]$AwsProfile = $env:AWS_PROFILE,
    [string]$AwsRegion = "us-east-1",
    [string]$DeploymentRoleName = "",
    [string]$EcrAccessRoleName = "",
    [string]$EcrRepository = "",
    [string]$AppRunnerServiceName = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Utf8NoBomFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Content
    )

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Resolve-AwsCli {
    $candidates = @(
        (Get-Command aws -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue),
        "C:\Program Files\Amazon\AWSCLIV2\aws.exe"
    ) | Where-Object { $_ }

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    throw "AWS CLI not found. Ensure aws.exe is installed and on PATH, or available at C:\Program Files\Amazon\AWSCLIV2\aws.exe."
}

function Invoke-AwsJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $output = & $script:AwsCli @script:AwsBaseArgs @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "AWS CLI command failed: aws $($script:AwsBaseArgs + $Arguments -join ' ')"
    }

    if (-not $output) {
        return $null
    }

    return $output | ConvertFrom-Json
}

function Invoke-AwsRaw {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    & $script:AwsCli @script:AwsBaseArgs @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "AWS CLI command failed: aws $($script:AwsBaseArgs + $Arguments -join ' ')"
    }
}

function Ensure-Role {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RoleName,

        [Parameter(Mandatory = $true)]
        [string]$TrustPolicyPath
    )

    & $script:AwsCli @script:AwsBaseArgs "iam" "get-role" "--role-name" $RoleName 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Invoke-AwsRaw -Arguments @("iam", "update-assume-role-policy", "--role-name", $RoleName, "--policy-document", "file://$TrustPolicyPath") | Out-Null
    } else {
        Invoke-AwsRaw -Arguments @("iam", "create-role", "--role-name", $RoleName, "--assume-role-policy-document", "file://$TrustPolicyPath") | Out-Null
    }

    return (Invoke-AwsJson -Arguments @("iam", "get-role", "--role-name", $RoleName)).Role.Arn
}

$AwsCli = Resolve-AwsCli
$AwsBaseArgs = @()
if ($AwsProfile) {
    $AwsBaseArgs += @("--profile", $AwsProfile)
}
if ($AwsRegion) {
    $AwsBaseArgs += @("--region", $AwsRegion)
}

$identity = Invoke-AwsJson -Arguments @("sts", "get-caller-identity")
if (-not $identity) {
    throw "Unable to resolve AWS caller identity. Run 'aws sso login --profile <profile>' first, then pass -AwsProfile <profile> or set AWS_PROFILE."
}

$accountId = $identity.Account
$repoSlug = "$GitHubOwner/$GitHubRepo"

if (-not $DeploymentRoleName) {
    $DeploymentRoleName = "$GitHubRepo-gha-apprunner-deploy"
}
if (-not $EcrAccessRoleName) {
    $EcrAccessRoleName = "$GitHubRepo-apprunner-ecr-access"
}
if (-not $EcrRepository) {
    $EcrRepository = $GitHubRepo.ToLowerInvariant()
}
if (-not $AppRunnerServiceName) {
    $AppRunnerServiceName = $GitHubRepo.ToLowerInvariant()
}

$oidcProviderArn = "arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com"
& $AwsCli @AwsBaseArgs "iam" "get-open-id-connect-provider" "--open-id-connect-provider-arn" $oidcProviderArn 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Creating GitHub Actions OIDC provider..."
    Invoke-AwsRaw -Arguments @(
        "iam",
        "create-open-id-connect-provider",
        "--url",
        "https://token.actions.githubusercontent.com",
        "--client-id-list",
        "sts.amazonaws.com"
    ) | Out-Null
}

$tempDir = Join-Path $env:TEMP ("apprunner-bootstrap-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDir | Out-Null

try {
    $deploymentTrustPolicy = @{
        Version = "2012-10-17"
        Statement = @(
            @{
                Effect = "Allow"
                Principal = @{
                    Federated = $oidcProviderArn
                }
                Action = "sts:AssumeRoleWithWebIdentity"
                Condition = @{
                    StringEquals = @{
                        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
                        "token.actions.githubusercontent.com:sub" = "repo:${repoSlug}:ref:refs/heads/main"
                    }
                }
            }
        )
    } | ConvertTo-Json -Depth 10

    $deploymentTrustPath = Join-Path $tempDir "deployment-trust.json"
    Write-Utf8NoBomFile -Path $deploymentTrustPath -Content $deploymentTrustPolicy
    $deploymentRoleArn = Ensure-Role -RoleName $DeploymentRoleName -TrustPolicyPath $deploymentTrustPath

    $deploymentPolicy = @{
        Version = "2012-10-17"
        Statement = @(
            @{
                Effect = "Allow"
                Action = @(
                    "apprunner:CreateService",
                    "apprunner:DescribeService",
                    "apprunner:ListServices",
                    "apprunner:UpdateService"
                )
                Resource = "*"
            },
            @{
                Effect = "Allow"
                Action = @(
                    "ecr:BatchCheckLayerAvailability",
                    "ecr:BatchGetImage",
                    "ecr:CompleteLayerUpload",
                    "ecr:CreateRepository",
                    "ecr:DescribeRepositories",
                    "ecr:GetAuthorizationToken",
                    "ecr:InitiateLayerUpload",
                    "ecr:PutImage",
                    "ecr:UploadLayerPart"
                )
                Resource = "*"
            },
            @{
                Effect = "Allow"
                Action = "iam:PassRole"
                Resource = "arn:aws:iam::${accountId}:role/$EcrAccessRoleName"
            }
        )
    } | ConvertTo-Json -Depth 10

    $deploymentPolicyPath = Join-Path $tempDir "deployment-policy.json"
    Write-Utf8NoBomFile -Path $deploymentPolicyPath -Content $deploymentPolicy
    Invoke-AwsRaw -Arguments @(
        "iam",
        "put-role-policy",
        "--role-name",
        $DeploymentRoleName,
        "--policy-name",
        "GitHubActionsAppRunnerDeploy",
        "--policy-document",
        "file://$deploymentPolicyPath"
    ) | Out-Null

    $ecrAccessTrustPolicy = @{
        Version = "2012-10-17"
        Statement = @(
            @{
                Effect = "Allow"
                Principal = @{
                    Service = "build.apprunner.amazonaws.com"
                }
                Action = "sts:AssumeRole"
            }
        )
    } | ConvertTo-Json -Depth 10

    $ecrAccessTrustPath = Join-Path $tempDir "ecr-access-trust.json"
    Write-Utf8NoBomFile -Path $ecrAccessTrustPath -Content $ecrAccessTrustPolicy
    $ecrAccessRoleArn = Ensure-Role -RoleName $EcrAccessRoleName -TrustPolicyPath $ecrAccessTrustPath

    Invoke-AwsRaw -Arguments @(
        "iam",
        "attach-role-policy",
        "--role-name",
        $EcrAccessRoleName,
        "--policy-arn",
        "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
    ) | Out-Null

    Write-Host ""
    Write-Host "AWS bootstrap complete."
    if ($AwsProfile) {
        Write-Host "AWS profile: $AwsProfile"
    }
    Write-Host ""
    Write-Host "Create these GitHub repository settings:"
    Write-Host "Secret:"
    Write-Host "  AWS_ROLE_ARN=$deploymentRoleArn"
    Write-Host ""
    Write-Host "Variables:"
    Write-Host "  AWS_REGION=$AwsRegion"
    Write-Host "  ECR_REPOSITORY=$EcrRepository"
    Write-Host "  APP_RUNNER_SERVICE_NAME=$AppRunnerServiceName"
    Write-Host "  APP_RUNNER_ECR_ACCESS_ROLE_ARN=$ecrAccessRoleArn"
    Write-Host "  APP_RUNNER_PORT=80"
    Write-Host ""
    Write-Host "Optional variable:"
    Write-Host "  APP_RUNNER_SERVICE_ARN=<leave blank for first deploy>"
} finally {
    if (Test-Path $tempDir) {
        Remove-Item -Path $tempDir -Recurse -Force
    }
}
