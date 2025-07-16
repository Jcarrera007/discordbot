const { Client, GatewayIntentBits } = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Store conversation history per user
const conversationHistory = new Map();

function addToHistory(userId, userMessage, botResponse) {
    if (!conversationHistory.has(userId)) {
        conversationHistory.set(userId, []);
    }
    
    const history = conversationHistory.get(userId);
    history.push({ user: userMessage, bot: botResponse, timestamp: Date.now() });
    
    // Keep only last 10 exchanges (20 messages total)
    if (history.length > 10) {
        history.shift();
    }
}

function getConversationContext(userId) {
    const history = conversationHistory.get(userId) || [];
    if (history.length === 0) return '';
    
    // Only include recent history (last 5 exchanges)
    const recentHistory = history.slice(-5);
    return recentHistory.map(exchange => 
        `User: ${exchange.user}\nBot: ${exchange.bot}`
    ).join('\n\n');
}

async function fetchWebContent(url) {
    try {
        const response = await axios.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const $ = cheerio.load(response.data);
        
        $('script, style, nav, footer, header, aside').remove();
        
        const title = $('title').text().trim();
        const content = $('body').text().replace(/\s+/g, ' ').trim();
        
        return {
            title,
            content: content.substring(0, 3000),
            url
        };
    } catch (error) {
        throw new Error(`Failed to fetch content: ${error.message}`);
    }
}

async function searchWeb(query) {
    try {
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        const response = await axios.get(searchUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const $ = cheerio.load(response.data);
        const results = [];
        
        $('div.g').slice(0, 3).each((i, element) => {
            const titleElement = $(element).find('h3');
            const linkElement = $(element).find('a[href]').first();
            const snippetElement = $(element).find('.VwiC3b, .s3v9rd');
            
            if (titleElement.length && linkElement.length) {
                results.push({
                    title: titleElement.text().trim(),
                    url: linkElement.attr('href'),
                    snippet: snippetElement.text().trim()
                });
            }
        });
        
        return results;
    } catch (error) {
        throw new Error(`Search failed: ${error.message}`);
    }
}

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    
    if (message.content.startsWith('!ask ')) {
        const prompt = message.content.slice(5);
        const userId = message.author.id;
        
        try {
            let enhancedPrompt = prompt;
            
            const systemPrompt = "You are a Discord bot with internet access. You can search the web and access current information. When users ask about your capabilities, tell them you have internet access and can search for current information using web search. You maintain conversation context and can refer to previous messages in the conversation.";
            
            // Get conversation context
            const conversationContext = getConversationContext(userId);
            
            // Build prompt with conversation context
            let contextPrompt = systemPrompt;
            if (conversationContext) {
                contextPrompt += `\n\nPrevious conversation:\n${conversationContext}`;
            }
            
            if (prompt.toLowerCase().includes('internet') || prompt.toLowerCase().includes('connection') || 
                prompt.toLowerCase().includes('access') || prompt.toLowerCase().includes('capabilities')) {
                enhancedPrompt = `${contextPrompt}\n\nUser question: ${prompt}`;
            } else if (prompt.toLowerCase().includes('search') || prompt.toLowerCase().includes('latest') || 
                prompt.toLowerCase().includes('current') || prompt.toLowerCase().includes('news')) {
                
                const searchResults = await searchWeb(prompt);
                if (searchResults.length > 0) {
                    const webContext = searchResults.map(result => 
                        `Title: ${result.title}\nSnippet: ${result.snippet}\nURL: ${result.url}`
                    ).join('\n\n');
                    
                    enhancedPrompt = `${contextPrompt}\n\nBased on this recent web information:\n\n${webContext}\n\nAnswer this question: ${prompt}`;
                } else {
                    enhancedPrompt = `${contextPrompt}\n\nUser question: ${prompt}`;
                }
            } else {
                enhancedPrompt = `${contextPrompt}\n\nUser question: ${prompt}`;
            }
            
            const result = await model.generateContent(enhancedPrompt);
            const response = await result.response;
            const text = response.text();
            
            // Save to conversation history
            addToHistory(userId, prompt, text);
            
            if (text.length > 2000) {
                message.reply(text.substring(0, 1997) + '...');
            } else {
                message.reply(text);
            }
        } catch (error) {
            console.error('Error generating response:', error);
            message.reply('Sorry, I encountered an error while processing your request.');
        }
    }
    
    if (message.content.startsWith('!search ')) {
        const query = message.content.slice(8);
        
        try {
            const searchResults = await searchWeb(query);
            
            if (searchResults.length === 0) {
                message.reply('No search results found.');
                return;
            }
            
            let resultText = `**Search results for: ${query}**\n\n`;
            searchResults.forEach((result, index) => {
                resultText += `**${index + 1}. ${result.title}**\n${result.snippet}\n${result.url}\n\n`;
            });
            
            if (resultText.length > 2000) {
                resultText = resultText.substring(0, 1950) + '...\n\n*Results truncated*';
            }
            
            message.reply(resultText);
        } catch (error) {
            console.error('Search error:', error);
            message.reply('Sorry, search is currently unavailable.');
        }
    }
    
    if (message.content.startsWith('!url ')) {
        const url = message.content.slice(5);
        
        try {
            const webContent = await fetchWebContent(url);
            
            const prompt = `Summarize this webpage content:\n\nTitle: ${webContent.title}\nURL: ${webContent.url}\nContent: ${webContent.content}`;
            
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            
            if (text.length > 2000) {
                message.reply(text.substring(0, 1997) + '...');
            } else {
                message.reply(text);
            }
        } catch (error) {
            console.error('URL fetch error:', error);
            message.reply('Sorry, I could not fetch content from that URL.');
        }
    }
});

client.login(process.env.DISCORD_TOKEN);