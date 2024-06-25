const express = require('express');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const Bottleneck = require('bottleneck');
const app = express();

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
async function scrapeRemoteJobs(searchTerm) {
    const jobs = new Set(); // Use a Set to ensure unique job entries
    let totalJobs = 0;
    const url = `https://remoteok.com/remote-${searchTerm}-jobs`;

    const scrape = async () => {
        try {
            const browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu'
                ]
            });
            const page = await browser.newPage();
            await page.setCacheEnabled(false);

            // Intercept requests to handle CORS and throttle requests
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                const headers = request.headers();
                headers['Access-Control-Allow-Origin'] = '*';
                request.continue({ headers });
            });

            await page.goto(url, { waitUntil: 'networkidle2' });

            // Scroll and load more jobs if applicable
            let previousHeight;
            while (true) {
                previousHeight = await page.evaluate('document.body.scrollHeight');
                await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
                await delay(2000); // Wait for 2 seconds between scrolls to reduce CPU usage
                const currentHeight = await page.evaluate('document.body.scrollHeight');
                if (currentHeight === previousHeight) break;
            }

            const html = await page.content();
            const $ = cheerio.load(html);

            // Extract total jobs from the specific element
            const jobsCountText = $('.action-remove-latest-filter').text().trim();
            const matches = jobsCountText.match(/(\d+)\+?/);
            if (matches) {
                totalJobs = parseInt(matches[1], 10);
            }
            console.log("matches", matches);

            // Extract job details
            $('.job').each((index, element) => {
                try {
                    const jobData = JSON.parse($(element).find('script[type="application/ld+json"]').html()); // Parse JSONLD data
                    const title = jobData.title;
                    const company = jobData.hiringOrganization.name;
                    let location = 'Location not specified'; // Default value for location

                    // Check if job location information is available and in the expected format
                    if (jobData.jobLocation && jobData.jobLocation.address && jobData.jobLocation.address.addressLocality) {
                        location = jobData.jobLocation.address.addressLocality;
                    }

                    const tags = $(element).find('.tags').text().replace(/[\t\n]+/g, ' ').trim(); // Remove newline characters and extra spaces
                    const link = 'https://remoteok.com' + $(element).find('a').attr('href');
                    let logoUrl = jobData.image;

                    // If logoUrl is empty, extract initials from SVG data attribute
                    if (!logoUrl) {
                        const initialsMatch = $(element).find('.logo.initials').text().trim();
                        if (initialsMatch) {
                            logoUrl = initialsMatch;
                        }
                    }

                    if (title && company && link) { // Ensure essential fields are present
                        const job = { title, company, location, tags, link, logoUrl };
                        jobs.add(JSON.stringify(job)); // Add job as a string to the Set to ensure uniqueness
                    }
                } catch (err) {
                    console.error('Error processing job element:', err);
                    // Continue with the next element if there's an error
                }
            });

            await browser.close();

        } catch (error) {
            console.error('Error scraping remote jobs:', error);
            return { jobs: [], totalJobs: 0, fetchedJobs: 0 };
        }

        const uniqueJobs = Array.from(jobs).map(job => JSON.parse(job));
        return { jobs: uniqueJobs, totalJobs, fetchedJobs: uniqueJobs.length };
    };

    return limiter.schedule(scrape); // Schedule the scrape with the limiter
}

// Endpoint to search for jobs
app.get('/search', async (req, res) => {
    const searchTerm = req.query.term;

    if (!searchTerm) {
        return res.status(400).json({ error: 'Please provide a search term' });
    }

    try {
        const { jobs, totalJobs, fetchedJobs } = await scrapeRemoteJobs(searchTerm);
        res.json({ jobs, totalJobs, fetchedJobs });
    } catch (error) {
        console.error('Error fetching jobs:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


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
