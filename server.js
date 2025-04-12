const express = require('express');
const fetch = require('node-fetch');
const jsdom = require('jsdom');
const cookieParser = require('cookie-parser');
const path = require('path');
const { JSDOM } = jsdom;

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Helper to fetch with cookie persistence
const fetchWithCookies = async (url, options = {}, cookies = {}, retries = 3) => {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
        'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'
    ];
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // Extended timeout
    try {
        const headers = {
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
            'referer': 'https://indown.io/',
            'origin': 'https://indown.io',
            'user-agent': userAgents[Math.floor(Math.random() * userAgents.length)],
            'sec-ch-ua': '"Google Chrome";v="129", "Chromium";v="129", "Not?A_Brand";v="24"', 
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'same-origin',
            'sec-fetch-user': '?1',
            'upgrade-insecure-requests': '1',
            'cache-control': 'no-cache',
            'pragma': 'no-cache',
            ...options.headers,
        };
        if (Object.keys(cookies).length) {
            headers['cookie'] = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
        }
        const response = await fetch(url, { ...options, headers, signal: controller.signal });
        const setCookies = response.headers.raw()['set-cookie'] || [];
        const newCookies = {...cookies}; // Keep existing cookies
        setCookies.forEach(cookie => {
            try {
                const [nameValuePart] = cookie.split(';');
                const [name, value] = nameValuePart.split('=');
                if (name && value) {
                    newCookies[name.trim()] = value.trim();
                }
            } catch (err) {
                console.warn('Failed to parse cookie:', cookie);
            }
        });
        console.log(`Fetch ${url}: Status ${response.status}, Cookies:`, newCookies);
        return { response, cookies: newCookies };
    } catch (error) {
        if (retries > 0 && (error.message.includes('403') || error.message.includes('429'))) {
            console.log(`Retrying ${url}, retries left: ${retries}, error: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 2000)); // Randomized delay
            return fetchWithCookies(url, options, cookies, retries - 1);
        }
        throw error.name === 'AbortError' ? new Error('Request timed out') : error;
    } finally {
        clearTimeout(timeoutId);
    }
};

// Helper to parse profile data
const parseProfileData = (html) => {
    const dom = new JSDOM(html);
    const profileBox = dom.window.document.querySelector('.profile-box');
    if (!profileBox) {
        return null;
    }
    const originalImage = profileBox.querySelector('.profile-container img')?.src || '';
    // Use proxied image URL
    const image = originalImage ? `/api/proxy-image?url=${encodeURIComponent(originalImage)}` : '/placeholder.jpg';
    const viewUrl = profileBox.querySelector('.profile-button a[href*="instagram.f"]')?.href || '#';
    return {
        image,
        viewUrl,
        downloadUrl: originalImage ? `/api/proxy-image?url=${encodeURIComponent(originalImage)}&download=true` : '#',
        fullName: profileBox.querySelector('h3')?.textContent || 'Unknown',
        username: profileBox.querySelector('.title')?.textContent || '@unknown',
        bio: profileBox.querySelector('p:not(.title)')?.textContent || 'No bio available',
        followers: profileBox.querySelector('table tr:nth-child(1) td')?.textContent || '0',
        isPrivate: profileBox.querySelector('table tr:nth-child(2) td')?.textContent || 'Unknown',
        isVerified: profileBox.querySelector('table tr:nth-child(3) td')?.textContent || 'Unknown',
    };
};

// API to proxy images
app.get('/api/proxy-image', async (req, res) => {
    const { url, download } = req.query;
    if (!url) {
        return res.status(400).send('Image URL required');
    }
    try {
        const response = await fetch(decodeURIComponent(url), {
            headers: {
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
                'referer': 'https://indown.io/',
            },
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.status}`);
        }
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        res.set('Content-Type', contentType);
        if (download === 'true') {
            res.set('Content-Disposition', 'attachment; filename="profile.jpg"');
        }
        const buffer = await response.buffer();
        res.send(buffer);
    } catch (error) {
        console.error('Image proxy error:', error);
        res.status(500).send('Failed to fetch image');
    }
});

// API to fetch token
app.get('/api/fetch-token', async (req, res) => {
    console.log('Attempting to fetch token from indown.io');
    let retries = 3;
    while (retries > 0) {
        try {
            const { response, cookies } = await fetchWithCookies('https://indown.io/insta-dp-viewer', {
                headers: {
                    'accept': 'text/html',
                    'cache-control': 'no-cache',
                    'pragma': 'no-cache',
                    'sec-fetch-mode': 'navigate',
                    'sec-fetch-site': 'same-origin'
                }
            });
            const html = await response.text();
            if (!response.ok) {
                console.error('Token fetch response:', { status: response.status, body: html.substring(0, 500) });
                throw new Error(`Token fetch failed: ${response.status}`);
            }
            const dom = new JSDOM(html);
            const tokenInput = dom.window.document.querySelector('input[name="_token"]');
            if (!tokenInput) {
                console.error('Token fetch HTML sample:', html.substring(0, 500));
                throw new Error('Token input not found');
            }
            console.log('Token fetched successfully:', tokenInput.value);
            return res.json({ token: tokenInput.value, cookies });
        } catch (error) {
            console.error('Token fetch attempt failed:', error.message);
            retries--;
            if (retries === 0) {
                console.log('All retries failed, returning hardcoded token');
                // Replace with your actual token and cookies - these are examples, you need real values
                const hardcodedResponse = {
                    token: "s0FRHuVl0gb4pEztUNvZhBsYCnv8GoQloNWafhJM", 
                    cookies: {
                        "XSRF-TOKEN": "eyJpdiI6IkRXZGZXTERMQnk1eTNYRzFzalA3VWc9PSIsInZhbHVlIjoibVR2bEhaeGRjblUyRitBcnJpXC9ZVEsydXhuQXlpZUV2Sk5QdFU2MWdVUytuSlF5N3JwOGZ0QkVNejFRTjJYdEUiLCJtYWMiOiI4MDc5ZDlkM2E4MjY3OTE5NGQ3YzQ2MTk3NTIxNTRhNGRkMDMyMTIzN2QwNWZjM2ZiZjAxMTQ3NmY2YTgzMzIzIn0=", 
                        "indown_session": "eyJpdiI6ImNHMEs0NVIrUElEYnNlcmtPUFVTcVE9PSIsInZhbHVlIjoieTJ2Q3FMalNDU0hkYWN6RnB1Wm9sdGFHdFFaSFBcL08xUVwvTkNZZnNQTFM1S0xJMlNvdkxJdm05MlpTb0g2WjhSIiwibWFjIjoiZGFkOWNkNzE1NmFkZWExODYzZjM5ZjQ2NjBmZWNlNWY2YjAzZjE5Y2UyNDA5NWMzODk4MTEwZDllYWEwMGVkNyJ9"
                    }
                };
                return res.json(hardcodedResponse);
            }
            await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));
        }
    }
});

// API to fetch profile
app.post('/api/fetch-profile', async (req, res) => {
    const { url, token, cookies = {} } = req.body;
    
    console.log('Fetch profile request:', { url, token, cookiesReceived: Object.keys(cookies).length > 0 });
    
    if (!url || !url.match(/^https:\/\/(www\.)?instagram\.com\/[a-zA-Z0-9._]+\/?$/)) {
        return res.status(400).json({ error: 'Invalid Instagram URL' });
    }
    if (!token) {
        return res.status(400).json({ error: 'Token required' });
    }

    // Ensure we have basic cookies even if not provided
    const baseCookies = Object.keys(cookies).length > 0 ? cookies : {
        "XSRF-TOKEN": "eyJpdiI6IkRXZGZXTERMQnk1eTNYRzFzalA3VWc9PSIsInZhbHVlIjoibVR2bEhaeGRjblUyRitBcnJpXC9ZVEsydXhuQXlpZUV2Sk5QdFU2MWdVUytuSlF5N3JwOGZ0QkVNejFRTjJYdEUiLCJtYWMiOiI4MDc5ZDlkM2E4MjY3OTE5NGQ3YzQ2MTk3NTIxNTRhNGRkMDMyMTIzN2QwNWZjM2ZiZjAxMTQ3NmY2YTgzMzIzIn0=", 
        "indown_session": "eyJpdiI6ImNHMEs0NVIrUElEYnNlcmtPUFVTcVE9PSIsInZhbHVlIjoieTJ2Q3FMalNDU0hkYWN6RnB1Wm9sdGFHdFFaSFBcL08xUVwvTkNZZnNQTFM1S0xJMlNvdkxJdm05MlpTb0g2WjhSIiwibWFjIjoiZGFkOWNkNzE1NmFkZWExODYzZjM5ZjQ2NjBmZWNlNWY2YjAzZjE5Y2UyNDA5NWMzODk4MTEwZDllYWEwMGVkNyJ9"
    };

    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
        try {
            // First, let's fetch the page to get fresh cookies
            console.log('Fetching initial page to get cookies...');
            const initialFetch = await fetchWithCookies('https://indown.io/insta-dp-viewer', {}, baseCookies);
            const freshCookies = initialFetch.cookies;
            
            console.log('Fresh cookies obtained:', Object.keys(freshCookies));
            
            // Add a delay before making the actual request
            await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
            
            // Step 1: Submit URL
            const formData = new URLSearchParams();
            formData.append('referer', 'https://indown.io/insta-dp-viewer');
            formData.append('locale', 'en');
            formData.append('i', '2001:4860:7:405::a4');
            formData.append('_token', token);
            formData.append('link', url);

            console.log('Submitting form with token:', token);
            
            const postResponse = await fetchWithCookies('https://indown.io/download', {
                method: 'POST',
                headers: { 
                    'content-type': 'application/x-www-form-urlencoded',
                    'referer': 'https://indown.io/insta-dp-viewer',
                    'origin': 'https://indown.io',
                    'x-requested-with': 'XMLHttpRequest'
                },
                body: formData,
            }, freshCookies);

            const postHtml = await postResponse.response.text();
            console.log('POST response status:', postResponse.response.status);
            
            if (postResponse.response.status === 403) {
                console.error('POST request blocked (403 Forbidden). Response body:', postHtml.substring(0, 500));
                throw new Error(`POST request blocked with 403 Forbidden. The site may be blocking scrapers.`);
            }

            // Check if POST response contains profile data
            let profileData = parseProfileData(postHtml);
            if (profileData) {
                console.log('Profile data found in POST response');
                return res.json(profileData);
            }

            // Expect 302, but handle other cases
            if (postResponse.response.status !== 302 && postResponse.response.status !== 200) {
                console.error('POST response body:', postHtml.substring(0, 500));
                if (postResponse.response.status === 429) {
                    attempt++;
                    console.log(`Rate limited, retrying (${attempt}/${maxRetries})...`);
                    await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
                    continue;
                }
                throw new Error(`POST failed: ${postResponse.response.status}`);
            }

            // Add a delay before the next request
            await new Promise(resolve => setTimeout(resolve, 1500 + Math.random() * 1000));
            
            // Step 2: Fetch profile data
            console.log('Following redirect to get profile data...');
            const mergedCookies = {...freshCookies, ...postResponse.cookies};
            console.log('Cookies for profile request:', Object.keys(mergedCookies));
            
            const profileResponse = await fetchWithCookies('https://indown.io/insta-dp-viewer', {
                headers: {
                    'referer': 'https://indown.io/download',
                    'cache-control': 'no-cache'
                }
            }, mergedCookies);
            
            const profileHtml = await profileResponse.response.text();
            console.log('GET response status:', profileResponse.response.status);

            if (!profileResponse.response.ok) {
                console.error('GET response body:', profileHtml.substring(0, 500));
                throw new Error(`Profile fetch failed: ${profileResponse.response.status}`);
            }

            profileData = parseProfileData(profileHtml);
            if (!profileData) {
                console.error('Profile HTML sample:', profileHtml.substring(0, 500));
                
                // Check if the page has a different structure
                const dom = new JSDOM(profileHtml);
                const possibleProfileImg = dom.window.document.querySelector('img.profile-pic');
                if (possibleProfileImg) {
                    console.log('Found alternative profile structure');
                    const alternativeProfileData = {
                        image: `/api/proxy-image?url=${encodeURIComponent(possibleProfileImg.src)}`,
                        downloadUrl: `/api/proxy-image?url=${encodeURIComponent(possibleProfileImg.src)}&download=true`,
                        username: dom.window.document.querySelector('.username')?.textContent || '@unknown',
                        fullName: dom.window.document.querySelector('.full-name')?.textContent || 'Unknown',
                        // Add other fields as needed
                    };
                    return res.json(alternativeProfileData);
                }
                
                throw new Error('Profile data not found');
            }

            res.json(profileData);
            return;
        } catch (error) {
            console.error('Attempt', attempt + 1, 'error:', error);
            if (attempt + 1 === maxRetries) {
                res.status(500).json({ error: error.message });
            }
            attempt++;
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/home.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/about.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

app.get('/contact.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'contact.html'));
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});