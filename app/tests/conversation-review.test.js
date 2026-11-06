const test = require('node:test');
const assert = require('node:assert/strict');
const {normalizeConversationReview:normalize,conversationReviewState:state,reviewPlan} = require('../lib/outreach/conversation-review');
const now=Date.parse('2026-10-19T15:00:00Z');
const at='2026-10-19T14:00:00Z';
const email='https://mail.google.com/mail/u/0/#all/original';
const linkedin='https://www.linkedin.com/messaging/thread/original/';
const record={id:'existing',kind:'recruiter',sourceUrl:email,linkedinSourceUrl:linkedin,schedulingUrl:'https://calendly.com/example/recruiter',lastInboundAt:'2026-10-17T10:00:00Z'};
const evidence=(channel,kind,result,extra={})=>({channel,kind,result,checkedAt:at,sourceUrl:channel==='linkedin'?linkedin:email,detail:'Actual bounded check of saved conversation',...extra});
const review=(extra={})=>({checkedAt:at,outcome:'needs_reply',summary:'Source checked',neededCoverage:['email','linkedin','booking'],evidence:[
  evidence('email','conversation','read',{latestDirection:'inbound'}), evidence('email','sent_search','none'),
  evidence('linkedin','conversation','read',{latestDirection:'inbound'}), evidence('linkedin','sent_search','none'),
  evidence('booking','booking_search','none'),
],...extra});

test('needs_reply requires complete direct conversation, sent and applicable booking evidence',()=>{
  assert.equal(normalize(review(),record).outcome,'needs_reply');
  for(let i=0;i<5;i++) assert.equal(normalize(review({evidence:review().evidence.filter((_,index)=>index!==i)}),record).outcome,'unverified');
  assert.equal(normalize(review({neededCoverage:['email'],evidence:review().evidence.slice(0,2)}),record).outcome,'unverified');
  const notification=review().evidence.map(item=>item.channel==='linkedin'?{...item,sourceUrl:email}:item);
  assert.equal(normalize(review({evidence:notification}),record).outcome,'unverified');
  const preview=review().evidence.map(item=>item.kind==='conversation'?{...item,latestDirection:undefined}:item);
  assert.equal(normalize(review({evidence:preview}),record).outcome,'unverified');
});

test('evidence matches saved identity; targeted search links back to exact conversation',()=>{
  const missing=review().evidence.map(item=>({...item,sourceUrl:'https://mail.google.com/mail/u/0/#search/other'}));
  assert.equal(normalize(review({evidence:missing}),record).outcome,'unverified');
  const search=review().evidence.map(item=>item.kind==='sent_search'&&item.channel==='email'?{...item,sourceUrl:'https://mail.google.com/mail/u/0/#search/recipient',conversationUrl:email}:item);
  assert.equal(normalize(review({evidence:search}),record).outcome,'needs_reply');
  const second='2-another-thread';
  const multiple={...record,relatedThreadIds:[second]};
  assert.equal(normalize(review(),multiple).outcome,'unverified');
  const secondUrl=`https://www.linkedin.com/messaging/thread/${second}/`;
  const complete=review({evidence:[...review().evidence,evidence('linkedin','conversation','read',{sourceUrl:secondUrl,latestDirection:'inbound'}),evidence('linkedin','sent_search','none',{sourceUrl:secondUrl})]});
  assert.equal(normalize(complete,multiple).outcome,'needs_reply');
  assert.match(normalize(review({summary:'Already booked, no reply needed',evidence:[]}),record).summary,/Verification needed/);
  assert.doesNotMatch(normalize(review({summary:'Already booked, no reply needed',evidence:[]}),record).summary,/Already booked/);
});

test('positive events suppress across channels only with source identity, actual event time and current direction',()=>{
  for(const [kind,outcome] of [['reply','awaiting_reply'],['booking','booked'],['closure','closed']]) {
    const found=evidence('email',kind,'found',{eventAt:'2026-10-18T10:00:00Z',latestDirection:'outbound'});
    assert.equal(normalize(review({outcome,evidence:[found]}),record).outcome,outcome);
    assert.equal(normalize(review({outcome,evidence:[{...found,eventAt:undefined}]}),record).outcome,'unverified');
    assert.equal(normalize(review({outcome,evidence:[{...found,eventAt:'2026-10-16T10:00:00Z'}]}),record).outcome,'unverified');
    assert.equal(normalize(review({outcome,evidence:[{...found,eventAt:'2026-10-20T10:00:00Z'}]}),record).outcome,'unverified');
    assert.equal(normalize(review({outcome,evidence:[{...found,sourceUrl:'https://mail.google.com/mail/u/0/#all/unrelated'}]}),record).outcome,'unverified');
  }
  assert.equal(normalize(review({outcome:'awaiting_reply',evidence:[evidence('email','reply','found',{eventAt:'2026-10-18T10:00:00Z',latestDirection:'inbound'})]}),record).outcome,'unverified');
  const researchRecord={...record,sourceLinks:['https://company.example/research']};
  assert.equal(normalize(review({outcome:'booked',evidence:[evidence('booking','booking','found',{eventAt:'2026-10-18T10:00:00Z',sourceUrl:'https://company.example/research'})]}),researchRecord).outcome,'unverified');
});

test('freshness uses actual evidence, future clocks and newest inbound including date-only history',()=>{
  const saved={...record,conversationReview:review()};
  assert.equal(state(saved,{},now).conversationReviewFresh,true);
  assert.equal(state(saved,{},now+24*3600000).conversationReviewFresh,false);
  assert.equal(state(saved,{},now-2*3600000).conversationReviewFresh,false);
  assert.equal(state(saved,{lastInboundAt:'2026-10-19T14:30:00Z'},now).conversationReview.outcome,'unverified');
  assert.equal(state(saved,{lastInboundDate:'2026-10-19'},now).conversationReviewFresh,false);
  const repackaged=review({evidence:review().evidence.map(item=>({...item,checkedAt:'2026-10-17T14:00:00Z'}))});
  assert.equal(state({...record,conversationReview:repackaged},{},now).conversationReview.outcome,'unverified');
});

test('plan checks at most three old saved candidates ordered oldest due then priority then newest inbound',()=>{
  const item=(id,extra={})=>({id,status:'ready_for_review',sourceUrl:email,...extra});
  const queue={items:[item('fresh',{priority:1}),item('due-later',{nextReminderAt:'2026-10-06T10:00:00Z'}),item('oldest',{nextReminderAt:'2026-09-01T10:00:00Z'}),item('due-first',{nextReminderAt:'2026-10-06T10:00:00Z',priority:1}),item('held',{status:'hold_user'}),item('sent',{sentAt:at}),item('future',{status:'reconnect_scheduled',nextReminderAt:'2026-11-01T10:00:00Z'})]};
  assert.deepEqual(reviewPlan({queue,now}).targets.map(item=>item.id),['oldest','due-first','due-later']);
  const tied={items:[item('older',{lastInboundAt:'2026-10-01T10:00:00Z',priority:1}),item('newer',{lastInboundAt:'2026-10-18T10:00:00Z',priority:1})]};
  assert.deepEqual(reviewPlan({queue:tied,now}).targets.map(item=>item.id),['newer','older']);
  const links=reviewPlan({brief:{opportunities:[{...record,sourceLinks:['https://company.example/research'],relatedThreadIds:['2-another-thread']}]},queue:{items:[item('existing')]},now}).targets[0];
  assert.equal(links.sourceLinks.includes('https://company.example/research'),false);
  assert.deepEqual(links.relatedThreadIds,['2-another-thread']);
});

test('plan reuses fresh complete needs_reply; stale positives are not scanned solely due to TTL',()=>{
  const queue={items:[{id:'existing',status:'ready_for_review'}]};
  const fresh={...record,conversationReview:review()};
  assert.deepEqual(reviewPlan({brief:{opportunities:[fresh]},queue,now}).reusedIds,['existing']);
  assert.deepEqual(reviewPlan({brief:{opportunities:[fresh]},queue,now}).targets,[]);
  assert.equal(reviewPlan({brief:{opportunities:[fresh]},queue,now:now+24*3600000}).targets.length,1);
  const positive={...record,conversationReview:review({outcome:'awaiting_reply',evidence:[evidence('email','reply','found',{eventAt:'2026-10-18T10:00:00Z',latestDirection:'outbound'})]})};
  assert.equal(reviewPlan({brief:{opportunities:[positive]},queue,now:now+7*24*3600000}).targets.length,0);
  const reminder={items:[{id:'existing',status:'snoozed',nextReminderAt:'2026-10-20T09:00:00Z'}]};
  assert.equal(reviewPlan({brief:{opportunities:[positive]},queue:reminder,now:now+7*24*3600000}).targets.length,1);
  positive.lastInboundAt='2026-10-20T10:00:00Z';
  assert.equal(reviewPlan({brief:{opportunities:[positive]},queue,now:now+7*24*3600000}).targets.length,1);
});

test('new inbound after a sent report or an explicit due reminder makes that conversation eligible',()=>{
  const sent={id:'existing',status:'awaiting_recruiter',sentAt:'2026-10-18T10:00:00Z'};
  const queue={items:[sent]};
  assert.equal(reviewPlan({brief:{opportunities:[record]},queue,now}).targets.length,0);
  assert.equal(reviewPlan({brief:{opportunities:[{...record,lastInboundAt:'2026-10-19T10:00:00Z'}]},queue,now}).targets.length,1);
  assert.equal(reviewPlan({brief:{opportunities:[record]},queue:{items:[{...sent,nextReminderAt:'2026-10-19T09:00:00Z'}]},now}).targets.length,1);
  assert.equal(state({...record,conversationReview:review()},{sentAt:'2026-10-19T14:30:00Z'},now).conversationReviewFresh,false);
});
