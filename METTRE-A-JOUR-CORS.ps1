$ErrorActionPreference = "Stop"

@'
{
  "CORSRules": [
    {
      "AllowedOrigins": [
        "https://gestion-equipe-jason.vercel.app",
        "https://gestion-equipe-jason-lavxdqhua-jason-50d3.vercel.app"
      ],
      "AllowedMethods": ["GET", "HEAD", "PUT", "POST", "DELETE"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag", "Retry-After", "x-amz-request-id", "x-amz-id-2"],
      "MaxAgeSeconds": 3600
    }
  ]
}
'@ | Set-Content -Path "$env:USERPROFILE\cors-b2.json" -Encoding ASCII

aws s3api put-bucket-cors `
  --bucket gestion-equipe-jason-b2-10go `
  --cors-configuration "file://$env:USERPROFILE\cors-b2.json" `
  --endpoint-url https://s3.eu-central-003.backblazeb2.com `
  --profile backblaze

if ($LASTEXITCODE -ne 0) {
  throw "La mise à jour CORS a échoué. Vérifie le message AWS CLI ci-dessus."
}

aws s3api get-bucket-cors `
  --bucket gestion-equipe-jason-b2-10go `
  --endpoint-url https://s3.eu-central-003.backblazeb2.com `
  --profile backblaze
