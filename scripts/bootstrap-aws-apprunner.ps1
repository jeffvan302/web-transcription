[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$GitHubOwner,

    [Parameter(Mandatory = $true)]
    [string]$GitHubRepo,

    [string]$AwsRegion = "us-east-1",
    [string]$DeploymentRoleName = "",
    [string]$EcrAccessRoleName = "",
    [string]$EcrRepository = "",
    [string]$AppRunnerServiceName = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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

    $output = & $script:AwsCli @Arguments
    if (-not $output) {
        return $null
    }

    return $output | ConvertFrom-Json
}

function Ensure-Role {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RoleName,

        [Parameter(Mandatory = $true)]
        [string]$TrustPolicyPath
    )

    try {
        $null = Invoke-AwsJson -Arguments @("iam", "get-role", "--role-name", $RoleName)
        & $script:AwsCli iam update-assume-role-policy --role-name $RoleName --policy-document "file://$TrustPolicyPath" | Out-Null
    } catch {
        & $script:AwsCli iam create-role --role-name $RoleName --assume-role-policy-document "file://$TrustPolicyPath" | Out-Null
    }

    return (Invoke-AwsJson -Arguments @("iam", "get-role", "--role-name", $RoleName)).Role.Arn
}

$AwsCli = Resolve-AwsCli

$identity = Invoke-AwsJson -Arguments @("sts", "get-caller-identity")
if (-not $identity) {
    throw "Unable to resolve AWS caller identity. Run 'aws configure', 'aws configure sso', or 'aws sso login' first."
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

$oidcProviderArn = "arn:aws:iam::$accountId:oidc-provider/token.actions.githubusercontent.com"
try {
    & $AwsCli iam get-open-id-connect-provider --open-id-connect-provider-arn $oidcProviderArn | Out-Null
} catch {
    Write-Host "Creating GitHub Actions OIDC provider..."
    & $AwsCli iam create-open-id-connect-provider `
        --url "https://token.actions.githubusercontent.com" `
        --client-id-list "sts.amazonaws.com" | Out-Null
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
                        "token.actions.githubusercontent.com:sub" = "repo:$repoSlug:ref:refs/heads/main"
                    }
                }
            }
        )
    } | ConvertTo-Json -Depth 10

    $deploymentTrustPath = Join-Path $tempDir "deployment-trust.json"
    Set-Content -Path $deploymentTrustPath -Value $deploymentTrustPolicy -Encoding utf8
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
                Resource = "arn:aws:iam::$accountId:role/$EcrAccessRoleName"
            }
        )
    } | ConvertTo-Json -Depth 10

    $deploymentPolicyPath = Join-Path $tempDir "deployment-policy.json"
    Set-Content -Path $deploymentPolicyPath -Value $deploymentPolicy -Encoding utf8
    & $AwsCli iam put-role-policy `
        --role-name $DeploymentRoleName `
        --policy-name "GitHubActionsAppRunnerDeploy" `
        --policy-document "file://$deploymentPolicyPath" | Out-Null

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
    Set-Content -Path $ecrAccessTrustPath -Value $ecrAccessTrustPolicy -Encoding utf8
    $ecrAccessRoleArn = Ensure-Role -RoleName $EcrAccessRoleName -TrustPolicyPath $ecrAccessTrustPath

    & $AwsCli iam attach-role-policy `
        --role-name $EcrAccessRoleName `
        --policy-arn "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess" | Out-Null

    Write-Host ""
    Write-Host "AWS bootstrap complete."
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
