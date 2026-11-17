// Deploys food-orders-mcp to Azure Container Apps (consumption plan).
//
//   az group create -n rg-food-orders -l westeurope
//   az deployment group create -g rg-food-orders -f main.bicep `
//     -p image=ghcr.io/<owner>/food-orders-mcp:0.1.0
//
// Creates: Log Analytics workspace, Container Apps environment, container app.
// The container app scales to zero when idle and is reachable over HTTPS.

targetScope = 'resourceGroup'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Prefix for resource names (lowercase letters, digits, hyphens).')
@minLength(3)
@maxLength(20)
param namePrefix string = 'food-orders'

@description('Public container image, e.g. ghcr.io/<owner>/food-orders-mcp:0.1.0 (linux/amd64).')
@minLength(1)
param image string

@description('Optional bearer token required on /mcp. Leave empty to run without authentication.')
@secure()
param mcpAuthToken string = ''

@description('Minimum replicas. 0 enables scale-to-zero (no compute cost when idle).')
@minValue(0)
@maxValue(10)
param minReplicas int = 0

@description('Maximum replicas. Keep small so a public endpoint cannot run up cost.')
@minValue(1)
@maxValue(10)
param maxReplicas int = 2

@description('Concurrent HTTP requests per replica before scaling out.')
@minValue(1)
param concurrentRequests int = 10

@description('Log Analytics retention in days.')
@minValue(30)
@maxValue(730)
param logRetentionInDays int = 30

var suffix = uniqueString(resourceGroup().id)
var workspaceName = '${namePrefix}-logs-${suffix}'
var environmentName = '${namePrefix}-env-${suffix}'
var appName = '${namePrefix}-${suffix}'

// Only define the secret when a token is supplied; Container Apps rejects empty secret values.
var secrets = empty(mcpAuthToken) ? [] : [
  {
    name: 'mcp-auth-token'
    value: mcpAuthToken
  }
]

var authEnv = empty(mcpAuthToken) ? [] : [
  {
    name: 'MCP_AUTH_TOKEN'
    secretRef: 'mcp-auth-token'
  }
]

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: logRetentionInDays
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'http'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: 'food-orders-mcp'
          image: image
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: concat(
            [
              {
                name: 'PORT'
                value: '3000'
              }
              {
                name: 'NODE_ENV'
                value: 'production'
              }
            ],
            authEnv
          )
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/healthz'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 2
              periodSeconds: 5
              timeoutSeconds: 3
              failureThreshold: 10
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 10
              periodSeconds: 15
              timeoutSeconds: 3
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/healthz'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-rule'
            http: {
              metadata: {
                concurrentRequests: string(concurrentRequests)
              }
            }
          }
        ]
      }
    }
  }
}

@description('Ingress hostname of the container app.')
output fqdn string = containerApp.properties.configuration.ingress.fqdn

@description('MCP endpoint to add as a ChatGPT / Gemini connector.')
output mcpEndpoint string = 'https://${containerApp.properties.configuration.ingress.fqdn}/mcp'

@description('Health probe endpoint.')
output healthEndpoint string = 'https://${containerApp.properties.configuration.ingress.fqdn}/healthz'

output containerAppName string = containerApp.name
output environmentName string = environment.name
output logAnalyticsWorkspaceName string = logAnalytics.name
