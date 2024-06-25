const express = require('express');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const rp = require('request-promise');
const cheerio = require('cheerio');
const async = require('async');
const fs = require('fs');
const os = require('os');
const app = express();

const CACHE_DIR = './cache';
const MAX_CACHE_SIZE_MB = 100;
const MAX_CACHE_SIZE_BYTES = MAX_CACHE_SIZE_MB * 1024 * 1024;

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR);
}

// Helper function to get resource usage
const logResourceUsage = () => {
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    console.log(`Memory Usage: RSS=${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB, Heap Total=${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB, Heap Used=${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    console.log(`CPU Usage: User=${cpuUsage.user / 1000} ms, System=${cpuUsage.system / 1000} ms`);
};

// Function to get cache file path
const getCacheFilePath = (searchTerm) => `${CACHE_DIR}/${searchTerm}.json`;

// Function to check cache size and clear if necessary
const checkAndClearCache = () => {
    const files = fs.readdirSync(CACHE_DIR);
    let totalSize = 0;
    const fileSizes = files.map(file => {
        const { size } = fs.statSync(`${CACHE_DIR}/${file}`);
        totalSize += size;
        return { file, size };
    });

    if (totalSize > MAX_CACHE_SIZE_BYTES) {
        console.log('Cache size exceeded, clearing cache...');
        fileSizes.sort((a, b) => b.size - a.size); // Sort by size, largest first
        for (const { file } of fileSizes) {
            fs.unlinkSync(`${CACHE_DIR}/${file}`);
            totalSize -= fileSizes.size;
            if (totalSize <= MAX_CACHE_SIZE_BYTES) break;
        }
    }
};

// Fetch jobs function
const fetchJobs = async (url) => {
    try {
        const html = await rp({ uri: url, followRedirect: true, maxRedirects: 10 });
        const $ = cheerio.load(html);
        const jobs = [];
        $('.job').each((index, element) => {
            const title = $(element).find('h2').text().trim();
            const company = $(element).find('.company').text().trim();
            const location = $(element).find('.location').text().trim();
            const link = 'https://remoteok.com' + $(element).find('a').attr('href');
            const tags = $(element).find('.tags').text().trim();
            jobs.push({ title, company, location, link, tags });
        });
        return jobs;
    } catch (error) {
        console.error('Error fetching jobs:', error);
        throw new Error('Error fetching jobs');
    }
};

// Queue for processing tasks
const queue = async.queue(async (taskData) => {
    const { url, searchTerm, callback } = taskData;
    const cacheFilePath = getCacheFilePath(searchTerm);
    checkAndClearCache();
    try {
        if (fs.existsSync(cacheFilePath)) {
            console.log(`Cache hit for search term: ${searchTerm}`);
            const cachedData = fs.readFileSync(cacheFilePath);
            callback(null, JSON.parse(cachedData));
        } else {
            console.log(`Fetching jobs from URL: ${url}`);
            const jobs = await fetchJobs(url);
            fs.writeFileSync(cacheFilePath, JSON.stringify(jobs));
            callback(null, jobs);
        }
    } catch (error) {
        console.error(`Error processing task for ${searchTerm}:`, error);
        callback(error);
    }
}, 1);

// Request handler
const handleRequest = async (req, res) => {
    const searchTerm = req.query.term || 'backend';
    const url = `https://remoteok.com/remote-${searchTerm}-jobs`;
    const promise = new Promise((resolve, reject) => {
        queue.push({ url, searchTerm, callback: (error, jobs) => error ? reject(error) : resolve(jobs) });
    });

    try {
        const jobs = await promise;
        res.json(jobs);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }

    logResourceUsage();
};

app.get('/search', handleRequest);

// Worker thread logic
if (!isMainThread) {
    parentPort.on('message', async (message) => {
        const { url, searchTerm } = message;
        console.log(`Worker received message to fetch jobs from: ${url}`);
        try {
            const jobs = await fetchJobs(url);
            parentPort.postMessage({ jobs });
        } catch (error) {
            parentPort.postMessage({ error: 'Error fetching jobs' });
        }
    });
} else {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}
