const { runWithProgress } = require('./node_scraper');

// KNOWN GOOD TEST DATA - replace these with parts you know have photos
const testData = [
  {
    partId: 4,
    partNumber: 'R220591',    // Replace with actual part number
    vehicleId: 1967,
    equipmentRefId: '11020'    // Replace with actual equipment reference
  },
  {
    partId: 4,
    partNumber: 'R220591',    // Another known good part
    vehicleId: 1912,
    equipmentRefId: '9969'
  }
];

// Run the test
(async () => {
  console.log('Starting test scrape with known good parts...');
  
  const results = await runWithProgress(
    (percent, message) => {
      console.log(`Progress: ${message}`);
    },
    testData  // Passing our test data instead of querying DB
  );

  console.log('\nTest completed with results:', {
    success: results.results.filter(r => r.nodePath).length,
    errors: results.results.filter(r => r.error).length,
    withImages: results.results.filter(r => r.imageZipPath).length
  });

  // Detailed results
  console.log('\nDetailed results:');
  results.results.forEach((result, i) => {
    console.log(`\nPart ${i+1}: ${result.partNumber}`);
    console.log(`- Status: ${result.error ? 'FAILED' : 'SUCCESS'}`);
    if (result.error) console.log(`- Error: ${result.error}`);
    console.log(`- Node Path: ${result.nodePath || 'None found'}`);
    console.log(`- Images: ${result.imageZipPath ? 'Saved to ' + result.imageZipPath : 'None captured'}`);
  });
})();