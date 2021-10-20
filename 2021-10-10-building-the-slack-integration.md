---
layout: post

title: "Integrating Coveo Search Results in Slack"
subtitle: "Expose secure, external content in other applications"

tags: [Search API, Analytics API, Node.js, Slack, Integration]

author:
  name: Wim Nijmeijer
  bio: Technical Evangelist
  image: 20180501/wim.jpg
---
Do you want to expose your external content in a securely fashion inside another application like Slack (or another application)? You can do it by following this guide!

<!-- more -->

## Use case 
Many times, people want to search their external content (like Jira, Confluence, Sharepoint online) inside an application like Slack. Slack offers the integration of custom applications but getting the content from multiple applications can be a burden. That is were Coveo comes in. Coveo already has connectors to index the content. During indexing document level security is also stored, which makes it possible to only show results which an end-user is allowed to see.

Using the Coveo Search API the content can be accessed from any application. Tracking user behaviour is an important aspect for Machine Learning and Search Analytics, therefore the application must perform the necessary Analytics API calls to measure it.

<img src="../master/images/modalsearch.png" width=400/>

## Requirements for the integration
* Results shown from Coveo must be security trimmed
* Sent proper Analytics events to the Analytics API (submit and click events)
* Provide Analytics context from which channel the search was coming from
* Use commands, shortcuts and modal windows within Slack
* Code [github](https://github.com/coveo-labs/coveo-slack-frontend-integration)

## Architecture
The Slack Application is installed inside the Slack environment. The Slack Application communicates through http requests with our Node.js application. The Node.js application is hosted on a Amazon AWS Lambda function, which is exposed using the Amazon API Gateway. Our Lambda function communicates with a Amazon DynamoDB for our searchToken cache. Executes searches to the Coveo Search API and writes analytics data using the Coveo Analytics API.

<img src="../master/images/architecture.png" width=500/>


## Security?!
In the requirements it is very clear that security is a top requirement. Only results allowed for the current user should be shown. Most [connectors](https://docs.coveo.com/en/1702) support document level security. That means that for every document the security of the source system is replicated inside the Coveo index. After building the [security cache]( https://docs.coveo.com/en/1719) the Coveo Platform knows exactly what your access rights are.
To get a search API token, we first need to call the [/token]( https://docs.coveo.com/en/56) endpoint of the search API using an Impersonation API key. The [code getNewSearchToken
](../master/index.js) first checks if a token is available in the DynamoDB table. If not it will execute a `/token` call against the Search API. To obtain this token an `impersonation API key` is used.

<img src="../master/images/gettoken.png" width=600/>

The [token returned by the search API]( https://docs.coveo.com/en/13) is then used to execute search results. The API key contains the current userId, based on that the security trimming of the search results is performed. 

In order to have a single app covering multiple clients, you can use the following URL parameters when you add the URL's to your Slack Application

| Name    | Contents                                                     | Example           |
| ------- | ------------------------------------------------------------ | ----------------- |
| org     | The Name of the Coveo Organization                           | workplcedem       |
| apiKey  | The Coveo API Key with Impersonation priviliges (see above). | sdfa1234-2341234  |


## Make it work

### Setup Coveo Platform
The first thing we need to setup is the API key, used for the [impersonation](https://docs.coveo.com/en/1707/manage-an-organization/privilege-reference#search-impersonate-domain). *Store this key in a save environment and do not expose it!* In the provided example it is stored in the AWS Application in the `.env` file. Using the impersonation API key a [search token](https://docs.coveo.com/en/56) is created, which is used for searches and storing analytics data.

We also need a [dimension](https://docs.coveo.com/en/1522/) to store our `channel` data. This `channel` data can then be used in Analytic reports.

Add the dimension called `Channel`, map it to: `c_context_channel`, For Search and Click events.

### Create Amazon DynamoDB table
Now that our Coveo Platform is setup, an Amazon DynamoDB table must be created. This table is used to store the cache for the generated search tokens.


```cmd
aws dynamodb create-table ^
  --attribute-definitions ^
    AttributeName=user,AttributeType=S ^
  --key-schema ^
    AttributeName=user,KeyType=HASH ^
  --table-name awsSlackCache ^
  --provisioned-throughput ^
    ReadCapacityUnits=1,WriteCapacityUnits=1 ^
```

### Create the Slack Application
A Slack App must be created and configured. Most important information we need from this configuration is the `Signing Secret` and the `Bot User OAuth Token`. This is needed for our Node.js application.

### Create the Node.js Application
The Node.js application needs to react on the requests sent by Slack. 

#### Commands
In the application you need to define:
```js
app.command('/search_for', async ({ command, ack, say, context, respond, payload }) => {
```

which is then mapped in the Slack Application at the `Slash commands`.

The `/search_for` command simply executes a search (first requesting a search token), and `responds` back to Slack by providing a list of results.

<img src="../master/images/searchfor.png" width=300/>

The `/search_for_modal` command opens a modal window, shows a search box, shows facets and the found results.

<img src="../master/images/modalsearch.png" width=400/>

Every time you update the searchbox content, or select a facet, the view of the modal window is updated.

#### Home Tab
The modal window is the same as when invoked from the `Home` Tab of the application.

<img src="../master/images/apphomesearch.png" width=400/>


#### Shortcuts
Reacting to shortcuts is defined differently. You must use:
```js
app.shortcut({ callback_id: /.*short-modal/, type: 'message_action' }, async ({ shortcut, ack, say, body, client, context, repsond }) => {
```

The `callback_id` is configured in the URL when creating the shortcut in the Slack Application.

<img src="../master/images/shortcut.png" width=300/>

The `callback_id` is the URL pointing to Amazon AWS + `/short-modal`.

#### Actions
Every button or other interaction which you want to catch, must first be configured as a content block with a `action_id`:
```js
    addMessageObj = {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": {
            "type": "plain_text",
            "text": "Attach to message",
            "emoji": true
          },
          "value": ClickUri,
          "action_id": "attachToMessage"
        }
      ]
    }
```
The `action_id` is then catched like:
```js
app.action('attachToMessage', async ({ action, ack, body, client, context, respond }) => {
```

#### Respond and report Analytic events for the Coveo Platform
When a search is being executed, an Analytics event must be sent to the Coveo Platform. In the Node.js application we use the `submitAnalyticsSearch` method.
This will send the current search information. The searchtoken already contains the user information, so that is also logged in the Analytics. If that should be avoided, you could simply specify `"anonymous": true` in the Analytics calls. Important here is that the `searchQueryUid` is the same as the one retrieved from the Search API. The `searchQueryUid` is also stored when opening documents. Based on that the Machine Learning can relate the two events together.

The second event we need to send is when end-users open the document. A `/click` event must be sent. Important, because the Machine Learning algorithms use this to report 'successful' searches.
Using `submitAnalyticsOpen` will sent the event. This event should only be sent when end-users click on the actual document. Therefore, we have constructed an open button to open documents.

### Deploy the Node.js on Amazon AWS
Use `npx serverless offline --noPrependStageInUrl` for local development (and use `ngrok` to expose the url).
Use `npx serverless deploy` to deploy to Amazon.

### Assign the proper security policy to your Lambda execution role
Make sure you add Read/Write access to your Lambda execution role on the created DynamoDB table.

### Configure the Slack App
`URL` is the AWS url of the API gateway.
1. Navigate to:

<img src="../master/images/interact.png" width=300/>

2. Enable `Interactivity`.
3. In the `Request URL`, enter: `URL`/slack/events.

<img src="../master/images/addrequest.png" width=400/>

4. In the `Shortcuts` add a new shortcut and enter:

<img src="../master/images/shortcut.png" width=400/>

For the `Callback ID` enter: `URL`/slack/events/short-modal

5. Navigate to `Slash commands`.
6. Create a new command, and enter:

<img src="../master/images/command1.png" width=400/>

For the `Request URL` enter: `URL`/slack/events

7. Create a new command, and enter:

<img src="../master/images/command2.png" width=400/>

For the `Request URL` enter: `URL`/slack/events

8. Navigate to `Event Subscriptions`.
9. Enable events subscriptions.
10. Enter the same request URL as in step 3.
11. Enable the `Subscribe to Bot events` as follows:

<img src="../master/images/eventsub.png" width=400/>

## Use it
Use Slack commands:
* `/search_for` to search for text
* `/search_for_modal` to search for text with a modal screen, you can use facets to refine

Use shortcuts:

<img src="../master/images/shortcutsearch.png" width=300/>

Use Home tab:

<img src="../master/images/apphomesearch.png" width=400/>

## Reference
Based on: 

https://github.com/coveo/Coveo-Coveo-Slack-Integration

https://slack.dev/bolt-js/concepts#creating-modals

https://api.slack.com/reference/block-kit/block-elements#external_select

https://app.slack.com/block-kit-builder

https://api.slack.com/surfaces/tabs/using

https://api.slack.com/interactivity/handling#responses

https://stackoverflow.com/questions/50981370/can-hubot-slack-bot-store-sessions

https://github.com/slackapi/bolt-js/issues/365

https://slack.dev/bolt-js/deployments/aws-lambda