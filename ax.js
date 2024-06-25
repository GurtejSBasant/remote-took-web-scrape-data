const axios = require('axios');

axios.get('https://remoteok.com/remote-backend-jobs', {
  maxRedirects: 0 // Disables automatic following of redirects
})
.then(response => {
  console.log(response.data);
})
.catch(error => {
  console.error(error);
});
