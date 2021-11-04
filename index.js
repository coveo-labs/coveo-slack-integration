const privateChannelPosition = 0;
const privateChannelNamePosition = 1;
const privateMessagePosition = 2;
const privateUserPosition = 3;
const privateTokenPosition = 4;
const privateAPIPosition = 5;
const privateOrgPosition = 6;
const userAgent = "Slack/1.0 (platform; Slack Integration)";
let COVEO_CONTEXT = {};

const { App, LogLevel, ExpressReceiver, AwsLambdaReceiver } = require('@slack/bolt');
const AWS = require("aws-sdk");

const request = require('request-promise');
//To get the .env file data for the environment variables
require('dotenv-safe').config();
const awsLambdaReceiver = new AwsLambdaReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

//Setup DynamoDB
//Set the proper region for AWS Dynamo 
AWS.config.update({ region: process.env.COVEO_AWS_REGION });
const tableName = "awsSlackCache";
const docClient = new AWS.DynamoDB.DocumentClient();

const app = new App({
  receiver: awsLambdaReceiver,
  token: process.env.SLACK_BOT_TOKEN,
  //logLevel: LogLevel.DEBUG,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true
});

const config = {
  coveo: {
    org: process.env.COVEO_ORG,
    apiKey: process.env.COVEO_API_KEY, //Must have Impersonation rights
    queryPipeline: process.env.COVEO_PIPELINE,
    searchHub: process.env.COVEO_SEARCHHUB,
    tab: process.env.COVEO_TAB,
    fullSearchPageUrl: process.env.COVEO_FULL_SEARCH,
    facets: JSON.parse(process.env.COVEO_FACETS_FIELDS),
    displayfields: JSON.parse(process.env.COVEO_DISPLAY_FIELDS),
    picturefields: JSON.parse(process.env.COVEO_PICTURE_FIELDS)
  },
  slack: {
    nbOfResultsModal: 5,
    nbOfResultsHome: 5,
    nbOfResultsChat: 3,
    homeTabSearchBoxActionId: "home_tab_searchBox_enter",
    homeTabSearchBoxSelectActionId: "home_tab_searchBoxSelect_enter",
    modalSearchBoxActionId: "modal_searchBox_enter"
  }
};

//Get the email of the current user
const getEmail = async (userId) => {
  const result = await app.client.users.info({
    token: process.env.SLACK_BOT_TOKEN,
    user: userId
  });
  return result.user.profile.email;
};

// Responding to /search_for
app.command('/search_for', async ({ command, ack, say, context, respond, payload }) => {
  console.log(JSON.stringify(command, null, 1));
  console.log(JSON.stringify(payload, null, 1));
  await ack();
  // Get the info from the command 
  let query = command.text || 'empty query';
  let username = command.user_name;

  let email = await getEmail(command.user_id);
  console.log(email);
  let visitor = reverseString(command.user_id);
  let searchToken = await checkSearchToken(context, visitor, email);

  // Call Coveo for results
  const coveoResultsJSON = await getCoveoResults(getOrgKey(), searchToken, command.user_name, query, '', 0, config.slack.nbOfResultsChat, config.coveo.queryPipeline, config.coveo.searchHub, config.coveo.tab, "https://slack.com/" + command.channel_name, command.channel_name);
  const coveoResults = JSON.parse(coveoResultsJSON);
  // Submit Analytics - Search call
  await submitAnalyticsSearch(coveoResults, query, '', visitor, searchToken, "https://slack.com/" + command.channel_name, command.channel_name, username);
  // Assemble Slack blocks
  blocksObj = getModalStartingBlocks(query, username);
  blocksObj = assembleResultsInBlocks(blocksObj, coveoResults, false, username, searchToken, coveoResults.searchUid, "https://slack.com/" + command.channel_name, command.channel_name);

  // respond with the results
  const result = await respond({
    blocks: blocksObj,
    context: context,
    unfurl_links: false,
    unfurl_media: false
  });
});

//reverseString, needed for our visitorId, based upon the user_id from Slack
function reverseString(str) {
  return (str || '').split('').reverse().join('');
}

const getAPIKey = () => {
  let key = process.env.COVEO_API_KEY;
  if (COVEO_CONTEXT.apiKey) {
    key = COVEO_CONTEXT.apiKey;
  }
  return key;
}

const getCoveoContextFromPrivateMetadata = (private_metadata) => {
  COVEO_CONTEXT.orgId = private_metadata.split(';')[privateOrgPosition];
  COVEO_CONTEXT.apiKey = private_metadata.split(';')[privateAPIPosition];
}

//Get the new Search Token. Using an Impersonation key against the Coveo Platform we receive a searchToken
const getNewSearchToken = async (userName) => {
  //Construct the userIds, based upon the email of the current user
  const postData = {
    userIds: [userName].map(user => {
      return { name: user, provider: "Email Security Provider" };
    })
  };

  //Execute the request against the /token endpoint
  return request(
    `${process.env.COVEO_ENDPOINT}/rest/search/v2/token`,
    {
      auth: { bearer: getAPIKey() },
      json: true,
      async: true,
      method: "POST",
      body: postData
    },
    (error, response, body) => {
    }
  );
};


//Do we have a valid searchtoken in the current conversation
//If not present, get it from the endpoint
const checkSearchToken = async (context, visitor, user) => {
  let token = '';
  //Get Token from dynamoDB
  token = await getTokenFromDynamoDB(visitor);
  console.log('Token from DynamoDB = ' + token);
  if (token == '') {
    console.log('SearchToken UNDEFINED');
    const newToken = await getNewSearchToken(user);
    if (newToken.token != undefined) {
      console.log('SearchToken retrieved');
      token = newToken.token;
      await putTokenInDynamoDB(visitor, token);
    }
  }
  return token;
};

// Listen for users opening your App Home
app.event('app_home_opened', async ({ event, client, context }) => {
  //console.log('Event:\n' + JSON.stringify(event, null, 1))
  try {
    // Call views.publish with the built-in client
    const result = await client.views.publish({
      // Use the user ID associated with the event
      user_id: event.user,
      view: {
        // Home tabs must be enabled in your app configuration page under "App Home"
        "type": "home",
        "blocks": getStartingBlocks(event.user, '', 0, 0, config.slack.homeTabSearchBoxActionId, '', []),
        "private_metadata": ';App Home;;;',
      },
      context: context
    });

    //console.log(result);
  } catch (error) {
    console.error(error);
  }
});

// Respond to openDocument button
app.action('openDocument', async ({ action, ack, body, client, context, respond }) => {
  // Acknowledge action request
  await ack();
  //Since the action.value contains the full URL including clickback
  //When people will click on the link to open it, the 'OpenDocument' for analytics will be called
  const url = new URL(action.value);
  await submitAnalyticsOpen(url.searchParams.get('searchUid'), url.searchParams.get('url'),
    url.searchParams.get('urihash'), url.searchParams.get('source'), url.searchParams.get('position'),
    url.searchParams.get('title'), url.searchParams.get('visitor'),
    url.searchParams.get('token'), url.searchParams.get('ref'), url.searchParams.get('ch'));
  //Now open the original URL
  //This will be handled by the link button, we do not have to do anything here
});

// Respond to Attach to message button
app.action('attachToMessage', async ({ action, ack, body, client, context, respond }) => {
  // Acknowledge action request
  await ack();
  //console.log(body.view.private_metadata);
  //The private_metadata contains a join of channel;message;user;searchToken
  let allData = body.view.private_metadata.split(';');
  channel = allData[privateChannelPosition];
  message = allData[privateMessagePosition];
  user = allData[privateUserPosition];
  getCoveoContextFromPrivateMetadata(body.view.private_metadata);
  if (message == '') {
    message = undefined;
  }
  //Since the action.value contains the full URL including clickback
  //When people will click on the link to open it, the 'OpenDocument' for analytics will be called
  const url = new URL(action.value);
  const result_title = decodeURIComponent(url.searchParams.get('title'));
  const result_url = decodeURIComponent(url.searchParams.get('url'));
  let titleObj = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `:page_facing_up: ${result_title}`,
    },
  };
  let openObj = {
    "type": "actions",
    "elements": [
      {
        "type": "button",
        "text": {
          "type": "plain_text",
          "text": `:link: Open`,
          "emoji": true
        },
        "value": action.value,
        "action_id": "openDocument",
        "url": result_url
      }
    ]
  };
  await client.chat.postMessage({
    token: process.env.SLACK_BOT_TOKEN,
    channel: channel,
    //user: user,
    thread_ts: message,
    //attachments: [{ "pretext": "See here:", "text": `:page_facing_up: <${action.value}|${action.value}>` }],
    //text: `:page_facing_up: <${action.value}|${result_title}>`,
    text: `:page_facing_up: ${result_title}`,
    blocks: [titleObj, openObj],
    unfurl_links: false,
    unfurl_media: false,
  });
});



// Respond to Home tab Search Box Enter key stroke
app.action(config.slack.homeTabSearchBoxActionId, async ({ action, ack, body, client, context }) => {
  // Acknowledge action request
  await ack();
  //console.log("Responding to Home tab search box Enter key stroke:\n" + JSON.stringify(action, null, 1));
  // Getting the query
  let query = action.value || "";
  let facets = getFacetInputsFromView(body.view.blocks);
  let aq = getFacetsFromState(body.view.state);

  const surface = "AppHomeTab"; // "AppHomeTab" | "Modal"
  const triggerId = ""; // Needed only for Modal surface
  const userid = body.user.id;
  const username = body.user.name;
  let { visitor, searchToken, channelname } = await getVisitorAndToken(body.user.id, body.view.private_metadata, context);
  getCoveoContextFromPrivateMetadata(body.view.private_metadata);

  console.log('SearchToken: ' + searchToken);
  //The searchToken will be attached to the private_metadata of the form
  let addAttachment = false;
  await getResultsAndPublishSearchUI(query, aq, surface, triggerId, "false", body, client, searchToken, facets, visitor, addAttachment, username, "https://slack.com/" + channelname, channelname, userid);

});

// Get the facet configuration from the current view
// We want this if the view was simply updated instead of re-constructing it
function getFacetInputsFromView(body) {
  let facets = [];
  body.map(item => {
    if (item.block_id == 'facet_section') {
      facets = item.accessory.option_groups;
    }
  });
  return facets;
}

//Get the query input from the state
function getQueryFromState(state) {
  let query = '';
  if (config.slack.modalSearchBoxActionId in state.values['search_input']) {
    query = state.values['search_input'][config.slack.modalSearchBoxActionId].value;
  }
  if (config.slack.homeTabSearchBoxActionId in state.values['search_input']) {
    query = state.values['search_input'][config.slack.homeTabSearchBoxActionId].value;
  }
  return query;
}

//Get the selected Facets from the State
function getFacetsFromState(state) {
  let facets = [];
  try {
    facets = state.values['facet_section']['facet_input'].selected_options;
    let aq = '';
    config.coveo.facets.map(field => {
      let values = [];
      facets.map((facet) => {
        let value = facet.value.split('$');
        if (field.field == value[0]) {
          // [JD] You could remove quotes and parentheses from value[1] to be safer
          values.push(`"${value[1]}"`);
        }
      });
      if (values.length > 0) {
        aq += ` @${field.field}==(${values.join(',')})`;
      }
    });
    return aq;
  }
  catch (e) {
    return '';
  }
}

//Get search Token from DynamoDB
const getTokenFromDynamoDB = async (user) => {
  let token = '';
  const params = {
    TableName: tableName,
    Key: {
      "user": user
    }
  };
  try {
    const result = await docClient.get(params).promise();
    //We have a valid token
    //Check if not expired
    const dbtime = result.Item['expire'];
    const date = new Date(dbtime * 1000);
    const hours10 = 1000 * 60 * 60 * 10;
    const now = Date.now();
    if ((now - date) > hours10) {
      //Too old, reset it
      token = '';
      console.log('Expired token, reset');
    } else {
      token = result.Item['token'];
    }
  } catch (error) {
    console.error(error);
    token = '';
  }
  return token;
};

//Put search Token in DynamoDB
const putTokenInDynamoDB = async (user, token) => {
  const expire = Math.floor(Date.now() / 1000);

  const params = {
    TableName: tableName,
    Item: {
      "user": user,
      "token": token,
      "expire": expire
    }
  };
  try {
    const result = await docClient.put(params).promise();
    //console.log(result);
  } catch (error) {
    console.error(error);
  }
};

//Construct Visitor and get Search Token
const getVisitorAndToken = async (userid, private_metadata, context) => {
  const visitor = reverseString(userid);
  console.log("Visitor: " + visitor);

  let searchToken = private_metadata;
  const tokenParts = searchToken.split(';');
  let channelname = tokenParts[privateChannelNamePosition];
  if (!tokenParts[privateTokenPosition]) {
    //We need to get a new searchtoken
    const email = await getEmail(userid);
    console.log(email);

    searchToken = await checkSearchToken(context, visitor, email);
    searchToken = private_metadata + '' + searchToken;
  }
  return { visitor: visitor, searchToken: searchToken, channelname: channelname };
};

//React on a change in facet selections
app.action('facet_input', async ({ action, ack, body, client, context }) => {
  // Acknowledge action request
  await ack();
  // Getting the query
  const query = getQueryFromState(body.view.state);
  //Create advanced query for the selectedFacets
  const aq = getFacetsFromState(body.view.state);
  //Get the facet controls from the current view
  const facets = getFacetInputsFromView(body.view.blocks);
  const surface = "Modal"; // "AppHomeTab" | "Modal"
  const triggerId = ""; // Needed only for Modal surface
  const userid = body.user.id;
  const username = body.user.name;

  let { visitor, searchToken, channelname } = await getVisitorAndToken(body.user.id, body.view.private_metadata, context);
  getCoveoContextFromPrivateMetadata(body.view.private_metadata);

  console.log('SearchToken: ' + searchToken);
  console.log('AQ:' + aq);
  let addAttachment = true;
  if (searchToken.split(';')[privateChannelPosition] == '') {
    addAttachment = false;
  }

  await getResultsAndPublishSearchUI(query, aq, surface, triggerId, "true", body, client, searchToken, facets, visitor, addAttachment, username, "https://slack.com/" + channelname, channelname);


});

// Respond to Modal Search Box Enter key stroke
app.action(config.slack.modalSearchBoxActionId, async ({ action, ack, body, client, context }) => {
  // Acknowledge action request
  await ack();
  //console.log("Responding to Modal search box Enter key stroke:\n" + JSON.stringify(action, null, 1));
  // Getting the query
  let query = action.value || "";
  let facets = getFacetInputsFromView(body.view.blocks);
  let aq = getFacetsFromState(body.view.state);
  const surface = "Modal"; // "AppHomeTab" | "Modal"
  const triggerId = ""; // Needed only for Modal surface
  const userid = body.user.id;
  const username = body.user.name;

  let { visitor, searchToken, channelname } = await getVisitorAndToken(body.user.id, body.view.private_metadata, context);
  getCoveoContextFromPrivateMetadata(body.view.private_metadata);

  let addAttachment = true;
  if (searchToken.split(';')[privateChannelPosition] == '') {
    addAttachment = false;
  }

  console.log('SearchToken: ' + searchToken);
  await getResultsAndPublishSearchUI(query, aq, surface, triggerId, "true", body, client, searchToken, facets, visitor, addAttachment, username, "https://slack.com/" + channelname, channelname);

});

//Respond to the shortcut
app.shortcut({ callback_id: /.*short-modal/, type: 'message_action' }, async ({ shortcut, ack, say, body, client, context, repsond }) => {
  // Acknowledge command request
  console.log("Responding to shortcut search in Coveo stroke:\n" + JSON.stringify(shortcut, null, 1));
  await ack();
  let addAttachment = true;
  let channel = shortcut.channel.id;
  let channelname = shortcut.channel.name;
  //Do not allow addAttachments with directmessage types
  if (shortcut.channel.name == "directmessage") {
    addAttachment = false;
    channel = '';
  }
  // Get the info from the command 
  let query = shortcut.message.text || ' ';
  let username = shortcut.user.username || 'John Doe';
  let userId = shortcut.user.id;
  const triggerId = shortcut.trigger_id;

  const surface = "Modal"; // "AppHomeTab" | "Modal"
  let visitor = reverseString(userId);
  console.log("Visitor: " + visitor);
  const email = await getEmail(userId);
  console.log(email);

  let searchToken = await checkSearchToken(context, visitor, email);
  console.log('SearchToken: ' + searchToken);
  //put channelid + message_ts in searchtoken
  searchToken = channel + ';' + channelname + ';' + shortcut.message_ts + ';' + shortcut.user.id + ';' + searchToken;
  searchToken += getAPIKey() + ';' + getOrgKey();

  await getResultsAndPublishSearchUI(query, '', surface, triggerId, "false", body, client, searchToken, undefined, visitor, addAttachment, username, "https://slack.com/" + channelname, channelname);


});

// Responding to /search_for_modal
app.command('/search_for_modal', async ({ command, ack, body, client, context, payload }) => {
  // Acknowledge command request
  await ack();
  console.log("Responding to modal search in Coveo COMMAND:\n" + JSON.stringify(command, null, 1));
  console.log("Responding to modal search in Coveo context:\n" + JSON.stringify(context, null, 1));

  // Get the info from the command 
  let query = command.text || ' ';
  let username = command.user_name || 'John Doe';
  let userId = command.user_id;
  const triggerId = command.trigger_id;
  let channel = command.channel_id;
  let channelname = command.channel_name;
  let addAttachment = true;
  //Do not allow with directmessage
  if (command.channel_name == "directmessage") {
    addAttachment = false;
    channel = '';
  }
  const surface = "Modal"; // "AppHomeTab" | "Modal"
  let visitor = reverseString(userId);
  console.log("Visitor: " + visitor);
  const email = await getEmail(userId);
  console.log(email);

  let searchToken = await checkSearchToken(context, visitor, email);
  console.log('SearchToken: ' + searchToken);
  searchToken = channel + ';' + channelname + ';' + '' + ';' + command.user_id + ';' + searchToken + ';';
  searchToken += getAPIKey() + ';' + getOrgKey();
  await getResultsAndPublishSearchUI(query, '', surface, triggerId, "false", body, client, searchToken, undefined, visitor, addAttachment, username, "https://slack.com/" + channelname, channelname);


});

const getResultsAndPublishSearchUI = async (query, aq, surface, triggerId, modalUpdate, body, client, searchToken, facets, visitor, addAttachment, username, referrer, context, userid) => {
  // Call Coveo for results
  allDataInToken = searchToken.split(';');
  originalToken = searchToken;
  searchToken = allDataInToken[privateTokenPosition];
  const coveoResultsJSON = await getCoveoResults(getOrgKey(), searchToken, username, query, aq, 0, config.slack.nbOfResultsHome, config.coveo.queryPipeline, config.coveo.searchHub, config.coveo.tab, referrer, context);
  const coveoResults = JSON.parse(coveoResultsJSON);
  // Execute Analytics call (submit search)
  await submitAnalyticsSearch(coveoResults, query, aq, visitor, searchToken, referrer, context, username);

  const totalCount = coveoResults.totalCount;
  console.log('totalCount = ' + totalCount);
  const nbOfReturnedResults = coveoResults.results.length;
  console.log('nbOfReturnedResults = ' + nbOfReturnedResults);

  //Always get the facets from the query
  facets = coveoResults.facets;
  let searchBoxActionId = config.slack.homeTabSearchBoxActionId;
  if (surface === "Modal") { searchBoxActionId = config.slack.modalSearchBoxActionId; }

  let blocksObj = getStartingBlocks(username, query, nbOfReturnedResults, totalCount, searchBoxActionId, searchToken, facets);

  if (totalCount > 0) {
    blocksObj = getNbOfResultsBlock(blocksObj, nbOfReturnedResults, totalCount);
    blocksObj = assembleResultsInBlocks(blocksObj, coveoResults, addAttachment, username, searchToken, coveoResults.searchUid, referrer, context);
  } else {
    noResultBlock = {
      type: "section",
      text: {
        "type": "mrkdwn",
        "text": `Sorry, no results`
      }
    };
    blocksObj.push(noResultBlock);
  }

  try {
    if (surface === "AppHomeTab") {
      // Call views.publish with the built-in client
      const result = await client.views.publish({
        // Use the user ID associated with the event
        user_id: userid,
        view: {
          // Home tabs must be enabled in your app configuration page under "App Home"
          "type": "home",
          "blocks": blocksObj,
          private_metadata: originalToken
        }
      });
      //console.log(result);
    } else if (surface === "Modal") {
      if (modalUpdate === "false") {  // [JD] Why use string? "false" and "true", you pass in this parameter, it can simply be true/false.
        const result = await client.views.open({
          trigger_id: triggerId,

          view: {
            type: "modal",
            title: {
              type: "plain_text",
              text: limitStringLength("Coveo Search App", 25)
            },
            close: {
              type: "plain_text",
              text: "Close"
            },
            blocks: blocksObj,
            private_metadata: originalToken
          }

        });
        //console.log(result);
      } else if (modalUpdate === "true") {
        const result = await client.views.update({
          response_action: "update",
          view_id: body.view.id,
          hash: body.view.hash,

          view: {
            type: "modal",
            title: {
              type: "plain_text",
              text: limitStringLength("Coveo Search App", 25)
            },
            close: {
              type: "plain_text",
              text: "Close"
            },
            blocks: blocksObj,
            private_metadata: originalToken

          }
        });
        //console.log(result);
      }
    } else {
      console.log("Coveo Search App Unexpected surface: " + surface);
    }
  } catch (error) {
    console.error(error);
  }
};

//Submit an Analytics Search request
const submitAnalyticsSearch = async (queryResults, query, aq, visitor, token, referrer, context, username) => {
  const endPoint = `${process.env.COVEO_ANALYTICS_ENDPOINT}/rest/ua/v15/analytics/search?access_token=${token}&prioritizeVisitorParameter=true&org=${getOrgKey()}&visitor=${visitor}`;
  let searchBody = {
    "language": "en",
    //"anonymous": false,
    //"username": username,
    "userDisplayName": username,
    "userAgent": userAgent,
    "originLevel1": process.env.COVEO_SEARCHHUB,
    "originLevel2": process.env.COVEO_TAB,
    "originLevel3": referrer,
    "searchQueryUid": queryResults.searchUid,
    "queryText": query,
    "actionCause": "searchboxSubmit",
    "actionType": "search box",
    "advancedQuery": aq,
    "numberOfResults": queryResults.totalCount,
    "responseTime": queryResults.duration,
    "queryPipeline": process.env.COVEO_PIPELINE,
  };
  if (context != undefined) {
    searchBody["customData"] = { "context_channel": context };
  }
  console.log("SubmitAnalyticsSearch");
  await request({
    "method": "POST",
    "url": endPoint,
    headers: {
      'accept': 'application/json',
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    "body": JSON.stringify(searchBody)
  },
    (err, httpResponse, body) => {
      if (err) {
        console.log('ERROR: ', err);
        throw new Error(`getCoveoResults failed: "${err}"`);
      }
      console.log('submitAnalyticsSearch response code: ', httpResponse.statusCode);
    });
};

//Submit an Analytics Open (Click) request
const submitAnalyticsOpen = async (searchUid, uri, urihash, sourceName, position, title, visitor, token, referrer, context) => {
  const endPoint = `${process.env.COVEO_ANALYTICS_ENDPOINT}/rest/ua/v15/analytics/click?access_token=${token}&prioritizeVisitorParameter=true&org=${getOrgKey()}&visitor=${visitor}`;
  let searchBody = {
    "language": "en",
    //We do not have to supply this, this is handled by the searchToken
    //"anonymous": false,
    //"username": visitor,
    "userDisplayName": visitor,
    "userAgent": userAgent,
    "originLevel1": process.env.COVEO_SEARCHHUB,
    "originLevel2": process.env.COVEO_TAB,
    "originLevel3": referrer,
    "searchQueryUid": searchUid,
    "documentUri": uri,
    "documentUriHash": urihash,
    "documentPosition": position,
    "sourceName": sourceName,
    "actionCause": "documentOpen",
    "documentTitle": title,
    "documentUrl": uri,
    "queryPipeline": process.env.COVEO_PIPELINE
  };
  if (context != undefined) {
    searchBody["customData"] = {};
    searchBody["customData"]["context_channel"] = context;
  }
  console.log("SubmitAnalyticsOpen");
  await request({
    "method": "POST",
    "url": endPoint,
    headers: {
      'accept': 'application/json',
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    "body": JSON.stringify(searchBody)
  },
    (err, httpResponse, body) => {
      if (err) {
        console.log('ERROR: ', err);
        throw new Error(`getCoveoResults failed: "${err}"`);
      }
      console.log('submitAnalyticsOpen response code: ', httpResponse.statusCode);
    });
};

module.exports.openhandler = async (req, res, callback) => {
  //Submit the Analytics Request
  // [JD] You could pass in req.queryStringParameters simply, and use ({searchUid, url, urihash, }) in the function definition (ust be mindful of url/uri)
  await submitAnalyticsOpen(req.queryStringParameters.searchUid, req.queryStringParameters.url, req.queryStringParameters.urihash, req.queryStringParameters.source, req.queryStringParameters.position, req.queryStringParameters.title, req.queryStringParameters.visitor, req.queryStringParameters.token, req.queryStringParameters.ref, req.queryStringParameters.ch);
  //Now open the original URL
  const response = {
    statusCode: '301',
    headers: {
      Location: req.queryStringParameters.url
    },
  };
  callback(null, response);
};


// Handle the Lambda function event
module.exports.handler = async (event, context, callback) => {
  console.log(event);
  // Since we do not control the app parameters and the event from AWS is not sent 1:1 we need to keep the queryStringParameters
  // Can contain org;apiKey
  if (event.queryStringParameters) {
    COVEO_CONTEXT.orgId = event.queryStringParameters.org;
    COVEO_CONTEXT.apiKey = event.queryStringParameters.apiKey;
  }
  const handler = await app.start();
  return handler(event, context, callback);
};


//Get the starting blocks for the modal screen
const getModalStartingBlocks = (query, userName) => {
  // Define Slack starting blocks object to append to
  const urlEncodedQuery = encodeURIComponent(query);
  return [{
    type: "header",
    text: {
      type: "plain_text",
      text: "Coveo Search Results"
    }
  },
  {
    type: "context",
    elements: [{
      type: "mrkdwn",
      text: `Hey ${userName}! Here are the ${config.slack.nbOfResultsChat} top results for your query: *${query}*`
    },
    {
      type: "mrkdwn",
      text: `<${config.coveo.fullSearchPageUrl}#q=${urlEncodedQuery}|Coveo full search page>`
    }
    ]
  }
  ];
};

//Add the Facet block
const addFacetInfo = (facets) => {
  return {
    "type": "section",
    "block_id": "facet_section",
    "text": {
      "type": "mrkdwn",
      "text": ":file_cabinet: Filters"
    },
    "accessory": {
      "action_id": "facet_input",
      "type": "multi_static_select",
      "placeholder": {
        "type": "plain_text",
        "text": "Select items"
      },
      "option_groups": facets
    }
  };
};

//Get the facets, if facets is already in the form of a block, then skip
const getFacets = (facets) => {
  //console.log(facets);
  if (facets.length == 0) return undefined;
  if (facets[0].field == undefined) {
    //Already created facet view, so return the facets
    console.log("We already have facets");
    return addFacetInfo(facets);
  }
  let facetFields = [];
  console.log("Construct new facets");
  config.coveo.facets.map(field => {
    let options = [];
    facets.map(facet => {
      if (facet.field == field.field) {
        facet.values.map(value => {
          //options.push({ "value": `${field.field}$${value.value}`, "text": { "type": "plain_text", "text": `${value.value} (${value.numberOfResults})` } });
          options.push({ "value": `${field.field}$${value.value}`, "text": { "type": "plain_text", "text": `${value.value}` } });
        });
        if (options.length > 0) {
          facetFields.push({ "label": { "type": "plain_text", text: `${field.caption}` }, "options": options });
        }
      }
    });
  });
  //console.log(facetFields);
  if (facetFields.length > 0) {
    return addFacetInfo(facetFields);
  } else return undefined;
};

//Get the startingBlocks for the input boxes
const getStartingBlocks = (userName, query, nbOfReturnedResults, totalCount, searchBoxActionId, searchToken, facets) => {
  const urlEncodedQuery = encodeURIComponent(query);
  let blocks = [
    {
      "type": "input",
      "dispatch_action": true,
      "block_id": 'search_input',
      "element": {
        "type": "plain_text_input",
        "action_id": searchBoxActionId,
        "placeholder": {
          "type": "plain_text",
          "text": "What are you looking for?"
        },
        initial_value: query,
        "dispatch_action_config": {
          "trigger_actions_on": ["on_enter_pressed"]
        }
      },
      "label": {
        "type": "plain_text",
        "text": "Search for:",
        "emoji": true
      }
    }
  ];
  let facet = getFacets(facets);
  if (facet != undefined) {
    blocks.push(facet);
  }
  return blocks;
};

const getNbOfResultsBlock = (blocksObj, nbOfReturnedResults, totalCount) => {
  const resultObj = {
    type: "context",
    elements: [{
      type: "mrkdwn",
      text: `Result ${1}-${nbOfReturnedResults} of ${totalCount}`
    }]
  };

  if (nbOfReturnedResults > 0) {
    blocksObj.push(resultObj);
  }

  return blocksObj;
};

const assembleResultsInBlocks = (blocksObj, coveoResults, addAttachment, visitor, searchToken, searchUid, referrer, context) => {
  // Assemble key result elements in blocks
  let index = 1;
  coveoResults.results.forEach(function (result) {
    //console.log(result);
    let Title = result.title;
    let excerptObj;
    let resourceTypeObj;
    let addMessageObj;
    const titleHighlights = result.titleHighlights;
    let ClickUri = result.clickUri;
    //In order to track click Open analytics events we need to construct it using the /opendocument route
    ClickUri = 'https://slack' + '?url=' + encodeURIComponent(result.clickUri);
    ClickUri += `&urihash=${result.raw.urihash}`;
    ClickUri += `&position=${index}`;
    ClickUri += `&title=${encodeURIComponent(result.title)}`;
    ClickUri += `&visitor=${visitor}`;
    ClickUri += `&token=${searchToken}`;
    ClickUri += `&source=${encodeURIComponent(result.raw.source)}`;
    ClickUri += `&searchUid=${searchUid}`;
    ClickUri += `&ref=${encodeURIComponent(referrer)}`;
    ClickUri += `&ch=${context}`;

    index += 1;
    //The ClickUri needs to have a callbackfunction to our instance
    //like appurl?url=ClickUri&
    let Excerpt = result.excerpt;
    const excerptHighlights = result.excerptHighlights;
    //const ResourceType = result.raw.commonresourcetype;

    Title = highlightKeywords(Title, titleHighlights);
    Excerpt = highlightKeywords(Excerpt, excerptHighlights);


    //Check for Facet values inside raw
    let displayFields = [];
    let imageField = '';
    config.coveo.displayfields.map(field => {
      if (result.raw[field.field]) {
        displayFields.push({ type: "plain_text", text: `${field.caption}: ${result.raw[field.field]}` });
      }
    });
    config.coveo.picturefields.map(field => {
      if (result.raw[field.field] && result.raw[field.srcfield]) {
        imageField = field.prefix + result.raw[field.field];
      }
    });

    let openObj = {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": {
            "type": "plain_text",
            "text": `:link: Open`,
            "emoji": true
          },
          "value": ClickUri,
          "action_id": "openDocument",
          "url": result.clickUri
        }
      ]
    };

    if (imageField != '') {
      titleObj = {
        type: "section",
        accessory: {
          "type": "image",
          "image_url": imageField,
          "alt_text": result.title
        },
        text: {
          type: "mrkdwn",
          //text: `:page_facing_up: <${ClickUri}|${Title}>\n${Excerpt}`,
          text: `:page_facing_up: ${Title}\n${Excerpt}`,
        }

      };
    } else {
      titleObj = {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:page_facing_up: ${Title}`,
        },
      };
    }

    if (displayFields.length > 0) {
      resourceTypeObj = {
        type: "context",
        elements: displayFields
      };
    }
    if (Excerpt !== "" && imageField == "") {
      excerptObj = {
        type: "section",
        text: {
          type: "mrkdwn",
          text: Excerpt
        }
      };
    }
    divider = {
      "type": "divider"
    };
    addMessageObj = {
          "type": "button",
          "text": {
            "type": "plain_text",
            "text": "Attach to message",
            "emoji": true
          },
          "value": ClickUri,
          "action_id": "attachToMessage"
        };

    blocksObj.push(titleObj); // Adding the result title
    //Add Buttons when in shortcut modal
    if (addAttachment) openObj.elements.push(addMessageObj); 
    blocksObj.push(openObj); // Adding the open button
    if (excerptObj != undefined) blocksObj.push(excerptObj); // Adding the result excerpt
    if (resourceTypeObj != undefined) blocksObj.push(resourceTypeObj); // Adding the result resourceType

    blocksObj.push(divider); // Adding divider
  });
  // }
  return blocksObj;
};


const limitStringLength = (str, n) => {
  return (str.length > n) ? str.substr(0, n - 4) + '...' : str;
};

const getOrgKey = () => {
  let org = process.env.COVEO_ORG;
  if (COVEO_CONTEXT.orgId) {
    org = COVEO_CONTEXT.orgId;
  }
  return org;
}

//get the coveo results by calling the Search API
const getCoveoResults = async (orgId, apiKey, username, query, aq, firstResult, nbOfResults, pipeline, searchHub, tab, referrer, context) => {
  const endPoint = `${process.env.COVEO_ENDPOINT}/rest/search/v2/?organizationId=${orgId}`;
  let searchBody = {
    "q": query,
    "aq": aq,
    "fieldsToInclude": [
      "clickableuri",
      "title",
      "date",
      "excerpt",
      "filetype",
      "language"
    ],
    "fieldsToExclude": [
      "documenttype",
      "size"
    ],
    "debug": true,
    "firstResult": firstResult,
    "numberOfResults": nbOfResults,
    "pipeline": pipeline,
    "searchHub": searchHub,
    "tab": tab,
    "referrer": referrer,
    "context": {
      "userName": username,
      "channel": context
    },
    "facets": []
  };
  //Add Facet Fields to includedFields
  config.coveo.facets.map(field => {
    //Add Facet Fields to includedFields
    //console.log(field);
    searchBody["fieldsToInclude"].push(field.field);
    //Add Facet Fields to facets
    let facet = {
      "facetId": field.field,
      "field": field.field,
      "type": "specific",
      "injectionDepth": 1000,
      "filterFacetCount": false,
      "numberOfValues": 8,
      "freezeCurrentValues": false,
      "preventAutoSelect": true,
      "isFieldExpanded": false
    };
    searchBody["facets"].push(facet);
  });
  //Add Display Fields to includedFields
  config.coveo.displayfields.map(field => {
    searchBody["fieldsToInclude"].push(field.field);
  });
  //Add Picture Fields to includedFields
  config.coveo.picturefields.map(field => {
    searchBody["fieldsToInclude"].push(field.field);
    searchBody["fieldsToInclude"].push(field.srcfield);
  });


  return request({
    "method": "POST",
    "url": endPoint,
    headers: {
      'accept': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    "body": JSON.stringify(searchBody)
  },
    (err, httpResponse, body) => {
      if (err) {
        console.log('ERROR: ', err);
        throw new Error(`getCoveoResults failed: "${err}"`);
      }
      console.log('getCoveoResults response code: ', httpResponse.statusCode);
    });
};

const highlightKeywords = (str, highlights) => {
  // Make keyword markdown substrings bold, adding * on each side
  let inc = 0; // track # of added * characters
  highlights.forEach(function (item) {
    const offset = parseInt(item.offset, 10);
    str = [str.slice(0, offset + inc), '*', str.slice(offset + inc)].join('');
    const length = parseInt(item.length, 10);
    str = [str.slice(0, offset + inc + length + 1), '*', str.slice(offset + inc + length + 1)].join('');
    inc = inc + 2;
  });
  return str;
};
