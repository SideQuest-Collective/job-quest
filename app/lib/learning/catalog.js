// Curated public references; no personal material belongs in this file.
// Source check dates are stored per resource; no implied viewing or completion.
module.exports = [
  {
    id: 'media:mit-hashing', kind: 'video', title: 'Hashing — MIT 6.006',
    url: 'https://www.youtube.com/watch?v=Nu8YGneFCWE', youtubeId: 'Nu8YGneFCWE',
    publisher: 'MIT OpenCourseWare', publisherId:'mit-ocw', topic:'hashing', goal: 'Explain when a hash table helps and what collisions change.',
    reflection: 'Without the video, explain a collision and one way to handle it. When would you choose a different data structure?',
    checkedAt: '2026-10-09',
  },
  {
    id: 'media:aws-resilience', kind: 'audio', title: 'Single region, zero excuses: mastering AWS resilience',
    url: 'https://aws.amazon.com/podcasts/aws-podcast/#726',
    audioUrl: 'https://d1le29qyzha1u4.cloudfront.net/AWS_Podcast_Episode_726.mp3',
    feedUrl: 'https://d3gih7jbfe3jlq.cloudfront.net/aws-podcast.rss',
    publisher: 'Official AWS Podcast · episode 726', publisherId:'aws', topic:'resilience', goal: 'Explain why multiple availability zones alone do not guarantee resilience.',
    reflection: 'Name one concrete failure scenario, the mitigation you would choose, and its cost. Which example from your own work supports that choice?',
    checkedAt: '2026-10-09',
  },
  {
    id: 'media:mit-bfs', kind: 'video', title: 'Breadth-first search — MIT 6.006',
    url: 'https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/resources/lecture-9-breadth-first-search/', youtubeId: 'oFVYVzlvk9c',
    publisher: 'MIT OpenCourseWare', publisherId:'mit-ocw', topic:'graph-traversal', goal: 'Explain how BFS finds shortest paths in an unweighted graph.',
    reflection: 'Explain why a queue matters in BFS. Give one graph where this method applies and one limitation.',
    practiceHref: '/#codelab', practiceTitle: 'Practice graph traversal in Code Lab', checkedAt: '2026-10-10',
  },
  {
    id: 'media:aws-database-scaling', kind: 'audio', title: 'Scaling your relational database on AWS',
    url: 'https://aws.amazon.com/podcasts/aws-podcast/#704',
    audioUrl: 'https://d1le29qyzha1u4.cloudfront.net/AWS_Podcast_Episode_704.mp3',
    feedUrl: 'https://d3gih7jbfe3jlq.cloudfront.net/aws-podcast.rss',
    publisher: 'Official AWS Podcast · episode 704', publisherId:'aws', topic:'database-scaling', goal: 'Compare vertical scaling, sharding and database connection management.',
    reflection: 'Choose a database bottleneck, a scaling approach and one operational trade-off. What would you measure first?',
    practiceHref: '/#sysdesign', practiceTitle: 'Practice database scaling in system design', checkedAt: '2026-10-10',
  },
];
