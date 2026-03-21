# Web Transcription

This repository contains the browser-based `yt-asr` GUI prototype derived from `web_requirements.md`.

## Local Development

```powershell
npm install
npm run dev
```

## Deployment Shape

The GitHub Actions workflow in `.github/workflows/deploy-apprunner.yml` deploys this app to AWS App Runner using a container image:

1. Build the app with Docker
2. Push the image to Amazon ECR
3. Create the App Runner service if it does not exist
4. Update the App Runner service if it already exists

The container serves the built Vite app through Nginx with SPA fallback routing.

## GitHub Repository Setup

If GitHub CLI is installed and authenticated:

```powershell
winget install GitHub.cli
gh auth login
.\scripts\publish-github.ps1 -GitHubOwner <your-github-user-or-org> -RepositoryName web-transcription -Visibility private
```

If you prefer, create the repository manually on GitHub, then run:

```powershell
git init -b main
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

## AWS Bootstrap

Before the GitHub Action can deploy, make sure your local AWS CLI can authenticate:

```powershell
aws configure sso
aws sso login
aws sts get-caller-identity
```

Then bootstrap the AWS-side roles needed by GitHub Actions and App Runner:

```powershell
.\scripts\bootstrap-aws-apprunner.ps1 -GitHubOwner <owner> -GitHubRepo <repo> -AwsRegion us-east-1 -AwsProfile <your-sso-profile>
```

That script creates or updates:

- The GitHub Actions OIDC provider in IAM
- A deployment role that GitHub Actions can assume
- An App Runner ECR access role for pulling private ECR images

## GitHub Repository Settings

After running the bootstrap script, add these repository settings in GitHub:

Secret:

- `AWS_ROLE_ARN`

Variables:

- `AWS_REGION`
- `ECR_REPOSITORY`
- `APP_RUNNER_SERVICE_NAME`
- `APP_RUNNER_ECR_ACCESS_ROLE_ARN`
- `APP_RUNNER_PORT`
- `APP_RUNNER_SERVICE_ARN` (optional, leave blank for the first deploy)

## Deploy

Push to `main` or trigger the `Deploy To App Runner` workflow manually.
