const express = require('express');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const Bottleneck = require('bottleneck');
const app = express();
const async = require('async');
const corsOptions = {
    origin: '*', // Allow requests from any origin
    methods: 'POST, GET, OPTIONS, PUT, DELETE', // Allow specified methods
    allowedHeaders: 'Content-Type', // Allow specified headers
};

// Use CORS middleware with the specified options
app.use(cors(corsOptions));

app.use(cors(corsOptions));
app.use(bodyParser.json({
    verify: (req, res, buf, encoding) => {
        try {
            console.log(buf.toString(encoding));
            JSON.parse(buf.toString(encoding)); // This will throw an error if the JSON is invalid
        } catch (e) {
            res.status(400).send({ error: 'Invalid JSON' });
            throw e;
        }
    }
}));

// Throttling using Bottleneck
const limiter = new Bottleneck({
    maxConcurrent: 1,  // Adjust concurrency as needed
    minTime: 2000      // Increase minimum time between requests
});

// Helper function for delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Scrape Remote Jobs Function

// Function to scrape remote jobs
// Function to scrape remote jobs

// Function to scrape remote jobs
async function scrapeRemoteJobs(searchTerm) {
    const jobs = new Set();
    const url = `https://remoteok.com/remote-${searchTerm}-jobs`;

    try {
        const response = await axios.get(url);

        const html = response.data;
        const $ = cheerio.load(html);

        // Example: Extracting job titles
        $('.job').each((index, element) => {
            const title = $(element).find('.title').text().trim();
            jobs.add(title);
        });

        return { jobs: Array.from(jobs), totalJobs: $('.job').length };

    } catch (error) {
        console.error('Error scraping remote jobs:', error);
        return { jobs: [], totalJobs: 0 };
    }
}

const rp = require('request-promise');

// Create a persistent queue manager
const queue = async.queue(async (taskData) => {
    const { url, searchTerm, callback } = taskData;
    try {
        // Make the request
        const html = await rp({
            uri: url,
            followRedirect: true,
            maxRedirects: 10,
        });

        // Load HTML content into Cheerio
        const $ = cheerio.load(html);

        // Extract jobs using Cheerio selectors
        const jobs = [];
        $('.job').each((index, element) => {
            const title = $(element).find('h2').text().trim();
            const company = $(element).find('.company').text().trim();
            const location = $(element).find('.location').text().trim();
            const link = 'https://remoteok.com' + $(element).find('a').attr('href');
            const tags = $(element).find('.tags').text().trim();

            const job = { title, company, location, link, tags };
            jobs.push(job);
        });

        // Pass the fetched jobs to the callback
        callback(null, jobs);

    } catch (error) {
        console.error(`Error fetching jobs for ${searchTerm}:`, error);
        callback(error); // Pass error to the callback
    }
}, 1); // Set concurrency level to 1 to ensure sequential processing

// Function to handle incoming requests
const handleRequest = async (req, res, next) => {
    const searchTerm = req.query.term || 'backend'; // Default search term
    const url = `https://remoteok.com/remote-${searchTerm}-jobs`;

    // Create a promise for the queue task
    const promise = new Promise((resolve, reject) => {
        queue.push({ url, searchTerm, callback: (error, jobs) => {
            if (error) {
                reject(error);
            } else {
                resolve(jobs);
            }
        }});
    });

    // Handle promise resolution
    try {
        const jobs = await promise;
        // Send the fetched jobs as JSON response
        res.json(jobs);
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// Route to handle incoming requests
app.get('/search', handleRequest);


// Middleware to parse JSON bodies
app.use(express.json());

app.post('/get-company-domain', async (req, res) => {
    const { companyName, apiKey } = req.body;

    if (!companyName || !apiKey) {
        return res.status(400).json({ error: 'Company name and API key are required' });
    }

    try {
        const response = await axios.post('https://api.apollo.io/api/v1/mixed_companies/search', {
            api_key: apiKey,
            q_organization_name: companyName,
            page: 1,
            per_page: 10
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache'
            }
        });

        const responseData = response.data;

        if (responseData.organizations && responseData.organizations.length > 0) {
            res.json({ data: responseData.organizations });
        } else {
            res.status(404).json({ error: 'Company domain not found' });
        }
    } catch (error) {
        console.error('Error fetching company domain:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/fetch-employees', async (req, res) => {
    const { api_key, q_organization_domains, position_title, person_seniorities } = req.body;

    try {
        const response = await axios.post('https://api.apollo.io/v1/mixed_people/search', {
            api_key,
            q_organization_domains,
            position_title,
            person_seniorities,
            page: 1,
            limit: 100
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache'
            }
        });

        if (response.status === 200) {
            res.status(200).json(response.data);
        } else {
            res.status(response.status).send(`Failed to fetch details: ${response.status} - ${response.statusText}`);
        }
    } catch (error) {
        res.status(500).send(`Error: ${error.message}`);
    }
});

app.post('/fetch-employees-emails', async (req, res) => {
    const { api_key, first_name, last_name, organization_name, domain } = req.body;

    try {
        const response = await axios.post('https://api.apollo.io/v1/people/match', {
            api_key,
            first_name,
            last_name,
            organization_name,
            domain,
            reveal_personal_emails: true
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache'
            }
        });

        if (response.status === 200) {
            res.status(200).json(response.data);
        } else {
            res.status(response.status).send(`Failed to fetch details: ${response.status} - ${response.statusText}`);
        }
    } catch (error) {
        res.status(500).send(`Error: ${error.message}`);
    }
});

const PORT = process.env.PORT || 4500;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
