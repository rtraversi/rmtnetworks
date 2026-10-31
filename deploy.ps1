Set-Location $PSScriptRoot

$branch = (git rev-parse --abbrev-ref HEAD).Trim()

$commitMsg = Read-Host "What did you change? (commit message)"

if ([string]::IsNullOrWhiteSpace($commitMsg)) {
    $commitMsg = "Site update"
}

git add .
git commit -m $commitMsg
# A non-zero exit here usually just means "nothing to commit"; still push in
# case there are earlier commits that haven't gone up yet.

# -u origin HEAD works on a brand-new branch too (plain "git push" fails there).
git push -u origin HEAD
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Push FAILED - nothing was deployed. See the git error above." -ForegroundColor Red
    Write-Host ""
    exit 1
}

Write-Host ""
if ($branch -eq 'main') {
    Write-Host "Done! Changes pushed to GitHub (main)." -ForegroundColor Green
    Write-Host "Netlify is deploying now - usually live in 30 seconds." -ForegroundColor Cyan
    Write-Host "https://rmtnetworks.com" -ForegroundColor Yellow
} else {
    Write-Host "Pushed branch '$branch' to GitHub." -ForegroundColor Green
    Write-Host "NOT live yet: Netlify only deploys main. Merge '$branch' into main to go live." -ForegroundColor Yellow
}
Write-Host ""
