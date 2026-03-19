# AWS Bedrock Setup Guide for NanoClaw

This guide walks you through setting up AWS Bedrock to work with your NanoClaw instance, ensuring ZDR (Zero Data Retention) compliance for sensitive customer data.

## Prerequisites

- AWS Account with appropriate permissions
- AWS CLI installed and configured
- NanoClaw repository cloned and set up

## Step 1: Enable AWS Bedrock Access

### 1.1 Request Model Access

1. Log into AWS Console
2. Navigate to **Amazon Bedrock** service
3. Go to **Model access** in the left sidebar
4. Click **Modify model access** or **Request model access**
5. Select the Claude models you want to use:
   - ✅ **Claude 3.5 Sonnet v2** (recommended for most tasks)
   - ✅ **Claude 3 Opus** (for complex reasoning)
   - ✅ **Claude 3 Haiku** (for fast, simple tasks)
6. Review and submit the request
7. Wait for approval (usually instant for standard accounts)

### 1.2 Verify Model Access

```bash
aws bedrock list-foundation-models --region us-east-1 --query 'modelSummaries[?contains(modelId, `anthropic.claude`)].modelId'
```

You should see model IDs like:
- `anthropic.claude-3-5-sonnet-20241022-v2:0`
- `anthropic.claude-3-opus-20240229-v1:0`
- `anthropic.claude-3-haiku-20240307-v1:0`

## Step 2: Configure AWS Credentials

### 2.1 Create IAM User or Role

Create an IAM user/role with the following permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": [
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-*"
      ]
    }
  ]
}
```

### 2.2 Configure AWS Credentials (Windows with PowerShell)

Since you're on Windows with `AWS.Tools.Installer`, you have two options:

**Option A: Use Environment Variables in .env (Recommended)**

This is the simplest approach - just add credentials to your `.env` file:

```bash
# In ~/nanoclaw/.env (WSL Ubuntu)
AWS_ACCESS_KEY_ID=your_access_key_here
AWS_SECRET_ACCESS_KEY=your_secret_key_here
AWS_REGION=us-east-1
```

Then sync to container:
```bash
wsl -d Ubuntu bash -c "cd ~/nanoclaw && cp .env data/env/env"
```

**Option B: Install AWS CLI v2 in WSL Ubuntu**

If you want to use AWS CLI for testing, install it in WSL:

```bash
# In WSL Ubuntu
wsl -d Ubuntu bash -c "
  curl 'https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip' -o '/tmp/awscliv2.zip' &&
  cd /tmp &&
  unzip awscliv2.zip &&
  sudo ./aws/install
"

# Then configure
wsl -d Ubuntu bash -c "aws configure"
# Enter your credentials:
# AWS Access Key ID: YOUR_ACCESS_KEY
# AWS Secret Access Key: YOUR_SECRET_KEY
# Default region name: us-east-1
# Default output format: json
```

**Option C: Use PowerShell AWS.Tools (For Testing Only)**

You can use PowerShell to test Bedrock access, but NanoClaw will use the .env credentials:

```powershell
# In PowerShell
Install-Module -Name AWS.Tools.BedrockRuntime -Force

# Set credentials
Set-AWSCredential -AccessKey YOUR_ACCESS_KEY -SecretKey YOUR_SECRET_KEY -StoreAs default

# Set region
Set-DefaultAWSRegion -Region us-east-1

# Test Bedrock access
Invoke-BRModel -ModelId "anthropic.claude-3-haiku-20240307-v1:0" -Body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":100,"messages":[{"role":"user","content":"Hello"}]}'
```

## Step 3: Configure NanoClaw for Bedrock

### 3.1 Update .env File

Add these variables to your `.env` file:

```bash
# AWS Bedrock Configuration
AWS_REGION=us-east-1
BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0

# Optional: Specific credentials for Bedrock (if different from default AWS config)
AWS_ACCESS_KEY_ID=your_access_key_here
AWS_SECRET_ACCESS_KEY=your_secret_key_here

# Slack Configuration (keep existing)
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...

# Ollama Configuration (keep existing for MCP tools)
OLLAMA_HOST=http://100.81.118.18:11434
```

### 3.2 Sync Environment to Container

```bash
wsl -d Ubuntu bash -c "cd ~/nanoclaw && cp .env data/env/env"
```

## Step 4: Verify Bedrock Connectivity

You can skip this step and go straight to testing with NanoClaw, or verify access first:

**Option A: Test with PowerShell (if you have AWS.Tools.BedrockRuntime)**

```powershell
# In PowerShell
Import-Module AWS.Tools.BedrockRuntime

# Test a simple call
$body = @{
    anthropic_version = "bedrock-2023-05-31"
    max_tokens = 100
    messages = @(
        @{
            role = "user"
            content = "Hello"
        }
    )
} | ConvertTo-Json -Depth 10

Invoke-BRModel -ModelId "anthropic.claude-3-haiku-20240307-v1:0" -Body $body -Region us-east-1
```

**Option B: Test with AWS CLI in WSL (if you installed it)**

```bash
wsl -d Ubuntu bash -c "aws bedrock-runtime invoke-model \
  --model-id anthropic.claude-3-haiku-20240307-v1:0 \
  --body '{\"anthropic_version\":\"bedrock-2023-05-31\",\"max_tokens\":100,\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}' \
  --region us-east-1 \
  /tmp/response.json && cat /tmp/response.json"
```

**Option C: Skip verification and test directly with NanoClaw**

The Bedrock agent will test connectivity when you send your first message. Check the logs for any authentication errors.

## Step 5: Data Privacy & Compliance

### 5.1 Bedrock Data Privacy Features

AWS Bedrock provides strong data privacy guarantees:

- ✅ **No Training on Your Data**: Prompts and completions are NOT used to train models
- ✅ **No Data Retention**: AWS does not store your prompts/responses beyond the API call
- ✅ **Regional Control**: Choose which AWS region processes your data
- ✅ **Encryption**: Data encrypted in transit and at rest
- ✅ **Audit Logging**: CloudTrail logs all API calls for compliance

### 5.2 Enable CloudTrail Logging (Optional but Recommended)

For compliance auditing:

1. Go to **AWS CloudTrail** in the console
2. Create a trail for Bedrock API calls
3. Configure S3 bucket for log storage
4. Enable log file validation

### 5.3 Set Up Budget Alerts (Recommended)

1. Go to **AWS Billing** → **Budgets**
2. Create a budget for Bedrock usage
3. Set alerts at 50%, 80%, 100% of budget
4. Typical usage: $10-50/month for moderate use

## Step 6: Model Selection Guide

Choose the right model for your use case:

| Model | Best For | Cost | Speed |
|-------|----------|------|-------|
| **Claude 3.5 Sonnet v2** | General purpose, balanced | Medium | Fast |
| **Claude 3 Opus** | Complex reasoning, code | High | Slower |
| **Claude 3 Haiku** | Simple tasks, high volume | Low | Very Fast |

**Recommendation**: Start with **Claude 3.5 Sonnet v2** - it's the best balance of capability, speed, and cost.

## Step 7: Cost Optimization

### 7.1 Prompt Caching

Bedrock supports prompt caching to reduce costs:
- System prompts and static context are cached
- Reduces token usage by up to 90% for repeated patterns
- NanoClaw will automatically use this feature

### 7.2 Ollama Integration

For cost-effective processing:
- Use Bedrock for orchestration and complex reasoning
- Delegate simple tasks to Ollama (free, local)
- NanoClaw will intelligently route tasks

### 7.3 Monitor Usage

```bash
# Check Bedrock usage
aws ce get-cost-and-usage \
  --time-period Start=2026-03-01,End=2026-03-31 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --filter file://bedrock-filter.json
```

## Step 8: Restart NanoClaw

Once configured, restart the service:

```bash
wsl -d Ubuntu bash -c "cd ~/nanoclaw && pkill -f 'tsx src/index.ts' && npm run dev"
```

## Troubleshooting

### "Access Denied" Errors

- Verify model access is enabled in Bedrock console
- Check IAM permissions include `bedrock:InvokeModel`
- Confirm AWS credentials are correctly configured

### "Model Not Found" Errors

- Verify the model ID is correct for your region
- Some models may not be available in all regions
- Try `us-east-1` or `us-west-2` for best model availability

### High Costs

- Enable prompt caching (NanoClaw does this automatically)
- Use Claude 3 Haiku for simple tasks
- Delegate more work to Ollama via MCP tools
- Set up AWS Budget alerts

### Slow Responses

- Claude 3.5 Sonnet is faster than Opus
- Use streaming for better perceived performance
- Consider using Haiku for time-sensitive tasks

## Security Best Practices

1. **Use IAM Roles** instead of access keys when possible
2. **Rotate credentials** regularly
3. **Enable MFA** on AWS account
4. **Use least-privilege** IAM policies
5. **Enable CloudTrail** for audit logging
6. **Set up Budget Alerts** to prevent unexpected costs

## Next Steps

After Bedrock is working:

1. **Test basic conversations** in your Slack channels
2. **Add MCP tools** for HubSpot, Notion, GitHub integration
3. **Implement context optimization** for different task types
4. **Set up monitoring** and alerting
5. **Configure prompt caching** strategies for your use cases

## Support Resources

- [AWS Bedrock Documentation](https://docs.aws.amazon.com/bedrock/)
- [Claude on Bedrock Guide](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude.html)
- [Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/)
- [AWS Support](https://console.aws.amazon.com/support/)

## Compliance & Privacy

AWS Bedrock meets the following compliance standards:
- SOC 1, 2, 3
- ISO 27001, 27017, 27018
- PCI DSS
- HIPAA eligible
- GDPR compliant

For ZDR compliance, ensure:
- ✅ Model access is properly configured
- ✅ CloudTrail logging is enabled
- ✅ Data residency requirements are met (choose appropriate region)
- ✅ Access controls are properly configured
