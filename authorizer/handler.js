'use strict';

console.log('Loading function');

var Client = require('3scale').Client;
var request = require('request');
var createClient = require('then-redis').createClient
var Q = require('q');
var _ = require('underscore')

var AWS = require('aws-sdk');
AWS.config.region = process.env.SERVERLESS_REGION;

var client = new Client(process.env.THREESCALE_PROVIDER_KEY);
var service_id = process.env.THREESCALE_SERVICE_ID

var authRepUserKey = Q.nbind(client.authrep_with_user_key, client);

var db = createClient({
  host: process.env.ELASTICACHE_ENDPOINT,
  port: process.env.ELASTICACHE_PORT
});

exports.handler = function(event, context, callback){
    console.log('Received event:', JSON.stringify(event, null, 2));
    var token = event.authorizationToken;

    db.get(token).then(function(value){
      if (value != null) {
        console.log('Token exists in cache, value is',value);

        //Send message on threescaleAsync SNS topic
        //message contains token
        var sns = new AWS.SNS();
        var message = {token: token}
        sns.publish({
            Message: JSON.stringify(message),
            TopicArn: process.env.SNS_TOPIC_ARN
        }, function(err, data) {
            if (err) {
                console.log(err.stack);
                return;
            }
            console.log('push sent',data);
            context.succeed(generatePolicy('user', 'Allow', event.methodArn));
        });
       } else {
          console.log('Token does not exist in cache');
          auth(token).then(function(result){
            console.log("3scale response",result);

            var metrics = _.pluck(result.usage_reports,'metric')
            var cached_key = service_id+":"
            _.each(metrics,function(m){
              cached_key += "usage['"+m+"']=1&"
            })

            //sotre key and its usage in cache
            db.set(token,cached_key);

            context.succeed(generatePolicy('user', 'Allow', event.methodArn));
          }).catch(function(err){
            console.log("ERROR:",err);
            context.succeed(generatePolicy('user', 'Deny', event.methodArn));
          }).done(function(){
            context.done();
          })
       }
    })
}

//Function  to authenticate against 3scale platform
function auth(token){
  var options = { 'user_key': token, 'usage': { 'hits': 1 }, 'service_id': process.env.THREESCALE_SERVICE_ID};
  var q = Q.defer();
  client.authrep_with_user_key(options, function (res) {
    if (res.is_success()) {
      q.resolve(res);
    } else {
      q.reject(res);
    }
  });
  return q.promise;
}

//Create a AWS Policy document that will be evaluate by the API Gateway
var generatePolicy = function(principalId, effect, resource) {
    var authResponse = {};
    authResponse.principalId = principalId;
    if (effect && resource) {
        var policyDocument = {};
        policyDocument.Version = '2012-10-17'; // default version
        policyDocument.Statement = [];
        var statementOne = {};
        statementOne.Action = 'execute-api:Invoke'; // default action
        statementOne.Effect = effect;
        statementOne.Resource = resource;
        policyDocument.Statement[0] = statementOne;
        authResponse.policyDocument = policyDocument;
    }
    return authResponse;
}
