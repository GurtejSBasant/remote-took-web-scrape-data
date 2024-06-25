const express = require('express');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');

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

// Scrape Remote Jobs Function
async function scrapeRemoteJobs(searchTerm, filters) {
    const jobs = new Set(); // Use a Set to ensure unique job entries
    let totalJobs = 0;
    let url = `https://remoteok.com/remote-${searchTerm}-jobs`; // Declare url using let instead of const

    // Append filters to the URL if provided
    if (filters) {
        const filterParams = new URLSearchParams();
        if (filters.benefits) filterParams.append('benefits', filters.benefits);
        if (filters.location) filterParams.append('location', filters.location);
        if (filters.min_salary) filterParams.append('min_salary', filters.min_salary);
        url += `?${filterParams.toString()}`;
    }

    try {
        console.log("url:",url)
        const browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle2' });

        // Scroll and load more jobs if applicable
        let previousHeight;
        while (true) {
            previousHeight = await page.evaluate('document.body.scrollHeight');
            await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
            await page.waitForFunction(
                `document.body.scrollHeight > ${previousHeight}`,
                { timeout: 3000 }
            ).catch(() => {
                // If the function times out, it means no new jobs were loaded
            });
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

        // Wait for lazy-loaded images to be visible
        $('.job').each((index, element) => {
            const jobDataHtml = $(element).find('script[type="application/ld+json"]').html();
            try {
                const jobData = JSON.parse(jobDataHtml); // Parse JSONLD data
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

                // Apply filters if provided
                if (filters) {
                    if (filters.company && !company.toLowerCase().includes(filters.company.toLowerCase())) {
                        return; // Skip this job if the company filter doesn't match
                    }
                    // Add more filters as needed...
                }

                if (title && company && link) { // Ensure essential fields are present
                    const job = { title, company, location, tags, link, logoUrl };
                    jobs.add(JSON.stringify(job)); // Add job as a string to the Set to ensure uniqueness
                }
            } catch (error) {
                console.error('Error parsing job data:', error);
                // Skip this job and continue with the next one
            }
        });

        await browser.close();

    } catch (error) {
        console.error('Error scraping remote jobs:', error);
        return { jobs: [], totalJobs: 0, fetchedJobs: 0 };
    }

    const uniqueJobs = Array.from(jobs).map(job => JSON.parse(job));
    return { jobs: uniqueJobs, totalJobs, fetchedJobs: uniqueJobs.length };
}






app.get('/search', async (req, res) => {
    const searchTerm = req.query.term;
    const filters = {
        benefits: req.query.benefits,
        location: req.query.location,
        min_salary: req.query.min_salary
    };

    if (!searchTerm) {
        return res.status(400).json({ error: 'Please provide a search term' });
    }

    try {
        const { jobs, totalJobs, fetchedJobs } = await scrapeRemoteJobs(searchTerm, filters);
        res.json({ jobs, totalJobs, fetchedJobs });
    } catch (error) {
        console.error('Error fetching jobs:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});





const PORT = process.env.PORT || 4500;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
