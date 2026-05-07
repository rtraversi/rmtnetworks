Set-Location $PSScriptRoot

$commitMsg = Read-Host "What did you change? (commit message)"

if ([string]::IsNullOrWhiteSpace($commitMsg)) {
    $commitMsg = "Site update"
}

git add .
git commit -m $commitMsg
git push

Write-Host ""
Write-Host "Done! Changes pushed to GitHub." -ForegroundColor Green
Write-Host "Netlify is deploying now - usually live in 30 seconds." -ForegroundColor Cyan
Write-Host "https://rmtnetworks.com" -ForegroundColor Yellow
Write-Host ""
