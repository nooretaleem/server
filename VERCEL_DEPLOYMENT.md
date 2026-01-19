# Vercel Deployment - QR Code Upload Setup

## ⚠️ Important: Cloud Storage Required

The current QR code upload implementation uses local filesystem storage, which **will NOT work on Vercel** because:

1. Vercel is a serverless platform
2. Files written to the filesystem are **ephemeral** and lost when the function ends
3. Static file serving from `/uploads` directory won't work on Vercel

## Solutions for Vercel

You need to implement one of these cloud storage solutions:

### Option 1: Vercel Blob Storage (Recommended)

1. Install Vercel Blob:
```bash
npm install @vercel/blob
```

2. Get your Vercel Blob token from Vercel dashboard

3. Update `accountcontroller.js`:
```javascript
const { put } = require('@vercel/blob');

// In uploadQrCode function:
const blob = await put(`qrcodes/${Date.now()}-${accountId}.png`, req.file.buffer, {
  access: 'public',
});
filePath = blob.url; // Save the cloud URL
```

### Option 2: AWS S3

1. Install AWS SDK:
```bash
npm install @aws-sdk/client-s3
```

2. Configure S3 credentials in environment variables

3. Upload files to S3 and save the S3 URL in database

### Option 3: Cloudinary

1. Install Cloudinary:
```bash
npm install cloudinary
```

2. Configure Cloudinary credentials

3. Upload files to Cloudinary and save the Cloudinary URL

## Current Status

- ✅ **Local Development**: Works with local filesystem
- ❌ **Vercel Production**: Requires cloud storage implementation

## Next Steps

1. Choose a cloud storage solution
2. Update the `uploadQrCode` function in `accountcontroller.js`
3. Update the `getQrImageUrl` function in the frontend to handle cloud URLs
4. Test on Vercel deployment

## Environment Detection

The code now automatically detects Vercel environment and will:
- Use memory storage (temporary) on Vercel
- Return an error if cloud storage is not configured
- Use disk storage in local development

