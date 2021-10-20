# Coveo Front End Slack Integration

## Use Case

You want to expose Coveo Search Results within a Slack Application.

Requirements:

- Respond to commands like /search_for, /search_for_modal
- App Home tab
- Apply context to the results (channel name)
- Support security using Search Tokens and an impersonation key (for the Coveo Platform)
- Use a cache in DynamoDB for the Search Tokens so that we do not have to get the `/token` every time

## Components

- AWS Lambda function, hosting the NodeJs application.
- AWS DynamoDB, for storing the search token cache (the cache consists of: visitorId, searchToken and expiration date).
- AWS API Gateway, pointing to the above AWS Lambda function.
- Slack Admin access to add a new Application.
- Coveo Impersonation Key for the authentication against the platform.

## Example of workflow for executing a command

<img src="./images/gettoken.png" width=600/>

## Instructions

### Create Impersonation key in Coveo platform

1. [Read more on Impersonation](https://docs.coveo.com/en/1707/manage-an-organization/privilege-reference#search-impersonate-domain)
2. [Create a Key](https://docs.coveo.com/en/82). Make sure you add `Search - Impersonation`, `Analytics - Data, Push` and `Analytics - Impersonate`.

   **_Keep that key private!!!_**

   Insert it only in the `.env` file (`COVEO_API_KEY`). Also put the `COVEO_ORG` in the `.env` file.

### Create Channel dimension in Coveo platform

To report on the Channel used in the requests, we need to add a [Dimension](https://docs.coveo.com/en/1522/).
Add the dimension called `Channel`, map it to: `c_context_channel`, For Search and Click events.

### Create DynamoDB table

Use script [./create_aws_database.cmd](./create_aws_database.cmd).

### Create a Slack app

1. As an admin in the Slack workspace, use _Create an App_:

![new Slack app](./images/addslack.png).

2. Create the app:

![name it](./images/addslack2.png).

3. Navigate to App's Home:

![App Home](./images/apphome.png).

4. In the `Show Tabs` section, enable `Home Tab`.
5. Disable the `Messages Tab`.
6. Navigate to `Basic Information`.
7. Navigate to `App Credentials`.
8. Show the `Signing Secret` and store it in the `.env` file as `SLACK_SIGNING_SECRET`.
9. Navigate to `OAuth & Permissions`.
10. Show the `Bot User OAuth Token` and store it in the `.env` file as `SLACK_BOT_TOKEN`.
11. Enable the following permissions at the `Scopes` section:

![scopes](./images/scopes.png)

- Channels:history
- Commands
- Groups:history
- Im:history
- Mpim:history
- Users:profile.read
- Users:read
- Users:read.email

### Create NodeJs app

1. Configure the `.env` file.

| Name                     | Contents                                                                                                                         | Example                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| SLACK_SIGNING_SECRET     | Slack Secret, revealed at Slack Application: `Basic Information -> App Credentials -> Signing Secret`                            | 9EX694251f5c56639EXAMPLE9e                                                                       |
| SLACK_BOT_TOKEN          | Slack Bot Token, revealed at Slack Application: `OAuth & Permissions -> OAuth Tokens for Your Workspace -> Bot User OAuth Token` | xoxb-1sdfs14-249sdfs50-bZsdfsdffsQGTT0W                                                          |
| APP_PORT                 | Port for NodeJs (if you run the NodeJs standalone)                                                                               | 3000                                                                                             |
| COVEO_ORG                | The Name of the Coveo Organization                                                                                               | workplmnc2v7                                                                                     |
| COVEO_API_KEY            | The Coveo API Key with Impersonation priviliges (see above). NEVER REVEAL THIS IN PUBLIC                                         | sdfecf-9ssde-4esdfs1-9sdfsdf8-csdf8c877b                                                         |
| COVEO_PIPELINE           | The Pipeline to use for the search                                                                                               | Search                                                                                           |
| COVEO_SEARCHHUB          | The name of the Search Hub to use                                                                                                | default                                                                                          |
| COVEO_TAB                | The name of the Search Tab to use                                                                                                | All                                                                                              |
| COVEO_FACETS_FIELDS      | The configuration for the facet fields                                                                                           | ` [{ "field": "source", "caption": "Source"}, {"field": "concepts", "caption": "Concepts" }]`    |
| COVEO_DISPLAY_FIELDS     | The configuration for the display fields                                                                                         | `[{ "field": "source", "caption": "Source" }]`                                                   |
| COVEO_PICTURE_FIELDS     | The configuration for the picture fields. If the `srcfield` and `field` are both present, the picture template will be used.     | `[{ "field": "mypic", "prefix": "https://labs.coveodemo.com/workplace/", "srcfield":"myrole" }]` |
| COVEO_FULL_SEARCH        | The url to point to the full search experience                                                                                   | https://www.coveo.com                                                                            |
| COVEO_ENDPOINT           | The Coveo endpoint to execute searches against                                                                                   | https://platform.cloud.coveo.com                                                                 |
| COVEO_ANALYTICS_ENDPOINT | The Coveo analytics endpoint to sent Search Analytics events to                                                                  | https://analytics.cloud.coveo.com                                                                |
| COVEO_AWS_ENDPOINT       | The AWS endpoint to the API Gateway                                                                                              | https://hg0g.execute-api.us-east-1.amazonaws.com/prod                                            |
| COVEO_AWS_REGION         | The region of your AWS installation                                                                                              | us-east-1                                                                                        |

### Host the NodeJs app

On Amazon, or on your local computer. If you use your local computer, use `ngrok` to expose it to the internet.
Use this [guide](https://slack.dev/bolt-js/deployments/aws-lambda).

Make sure to use the following serverless.yml:

```yaml
service: coveo-slack-integration
frameworkVersion: '2'
provider:
  name: aws
  runtime: nodejs12.x
  environment:
functions:
  slack:
    handler: index.handler
    events:
      - http:
          path: slack/events
          method: post
plugins:
  - serverless-offline
```

Use `npx serverless offline --noPrependStageInUrl` for local development (and use `ngrok` to expose the url).
Use `npx serverless deploy` to deploy to amazon.

### Assign proper security policy to Lambda execution role

Once the DynamoDB table is created and the Lambda functions are created:

1. Get your DynamoDB arn. Click on:

   ![get arn](./images/getarnfromdb.png)

2. Copy from the `General Information` panel the: `Amazon Resource Name (ARN)`.

3. Go to your Lambda Function and click on `Configuration`

   ![lambda configuration](./images/addexecutionrole.png)

4. Click on the `Execution role` hyperlink.
5. Click on `Create Policy`.
6. Add the policy like:

   ![policy configuration](./images/addpolicy.png)

- Select `Service`: DynamoDB
- Actions: Read + Write
- Resources: expand the list. At the `Table` level hit `add arn`.
- Now add the `arn` from `Step 2`.
- Hit `Add`
- Click on `Next: Tags`
- Click on `Next: Review`
- Give it a name `SlackTableReadWrite`
- Hit `Create Policy`

7. Add the policy to your Lambda function:

   ![add policy](./images/addpolicytolambda.png)

### Configure the Node.js App

1. Change the `.env` file with the proper keys (`COVEO_AWS_ENDPOINT`)

### Configure Slack app

`URL` is the endpoint of your Node.js application (ie. AWS API Gateway, ngrok, Heroku, ...).

1. Navigate to:

   <img src="./images/interact.png" width=300/>

2. Enable `Interactivity`.
3. In the `Request URL`, enter: `URL`/slack/events.

   <img src="./images/addrequest.png" width=400/>

4. In the `Shortcuts` add a new shortcut and enter:

   For the `Callback ID` enter: `URL`/slack/events/short-modal

   <img src="./images/shortcut.png" width=400/>

5. Navigate to `Slash commands`.
6. Create a new command `/search_for`:

   For the `Request URL` enter: `URL`/slack/events

   <img src="./images/command1.png" width=400/>

7. Create a new command `/search_for_modal`:

   For the `Request URL` enter: `URL`/slack/events

   <img src="./images/command2.png" width=400/>

8. Navigate to `Event Subscriptions`.
9. Enable events subscriptions.
10. Enter the same request URL as in step 3.
11. Enable the `Subscribe to Bot events` as follows:

    <img src="./images/eventsub.png" width=400/>

## References

Useful documentation links:

https://github.com/coveo/Coveo-Coveo-Slack-Integration

https://slack.dev/bolt-js/concepts#creating-modals

https://api.slack.com/reference/block-kit/block-elements#external_select

https://app.slack.com/block-kit-builder

https://api.slack.com/surfaces/tabs/using

https://api.slack.com/interactivity/handling#responses

https://stackoverflow.com/questions/50981370/can-hubot-slack-bot-store-sessions

https://github.com/slackapi/bolt-js/issues/365

https://slack.dev/bolt-js/deployments/aws-lambda

## Version
`1.2.0` October 2021, Wim Nijmeijer

- Added Open Button so that nothing is exposed in the UI

`1.1.0` October 2021, Wim Nijmeijer

- Added Amazon DynamoDB cache for searchTokens
- Fixed deployment issues for Amazon
- Changed visitor in Analytics and Search in username
- Added referrer in events
- Added context channel to events
- Adding waiting for analytic events

`1.0.0` September 2021, Wim Nijmeijer
