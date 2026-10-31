import logger from '../config/logger';
import axios from 'axios';
import { Feedback } from '../models/Feedback';

export const syncFacebookReviews = async () => {
    const PAGE_ID = process.env.FB_PAGE_ID;
    const ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;

    if (!PAGE_ID || !ACCESS_TOKEN) {
        throw new Error('Facebook credentials are not configured.');
    }

    try {
        // 1. URL for regular Page Feed (Comments)
        const feedUrl = `https://graph.facebook.com/v25.0/${PAGE_ID}/feed?fields=message,created_time,comments{message,from{name,id},created_time}&limit=100&access_token=${ACCESS_TOKEN}`;

        // 2. URL for Page Recommendations (Reviews)
        const ratingsUrl = `https://graph.facebook.com/v25.0/${PAGE_ID}/ratings?fields=has_rating,has_review,rating,review_text,created_time,reviewer{name,id}&access_token=${ACCESS_TOKEN}`;

        logger.info({ pageId: PAGE_ID }, '[v0] Syncing Feed and Recommendations');

        // Fetch both in parallel to save time
        const [feedResponse, ratingsResponse] = await Promise.all([
            axios.get(feedUrl, { timeout: 30000 }),
            axios.get(ratingsUrl, { timeout: 30000 })
        ]);

        let inserted = 0;
        let skipped = 0;

        // --- PART A: PROCESS RECOMMENDATIONS (REVIEWS) ---
        if (ratingsResponse.data?.data) {
            for (const rev of ratingsResponse.data.data) {
                // Facebook calls them 'ratings', we only want those with text reviews
                if (!rev.review_text) continue;

                const externalId = `rev_${rev.reviewer?.id || 'anon'}_${new Date(rev.created_time).getTime()}`;
                const exists = await Feedback.findOne({ externalId });

                if (exists) {
                    skipped++;
                    continue;
                }

                await Feedback.create({
                    name: rev.reviewer?.name || 'Facebook Customer',
                    email: 'facebook@placeholder.com',
                    rating: rev.rating || 5, // Uses the actual star rating (1-5)
                    title: 'Facebook Recommendation',
                    feedback: rev.review_text,
                    status: 'pending',
                    source: 'facebook',
                    externalId: externalId,
                    profileUrl: rev.reviewer?.id ? `https://facebook.com/${rev.reviewer.id}` : null,
                });
                inserted++;
            }
        }

        // --- PART B: PROCESS FEED COMMENTS ---
        const posts = feedResponse.data?.data || [];
        for (const post of posts) {
            if (!post.comments?.data) continue;

            for (const comment of post.comments.data) {
                try {
                    const exists = await Feedback.findOne({ externalId: comment.id });
                    if (exists) {
                        skipped++;
                        continue;
                    }

                    await Feedback.create({
                        name: comment.from?.name || 'Facebook User',
                        email: 'facebook@placeholder.com',
                        rating: 5, // Default for comments since they don't have stars
                        title: 'Facebook Comment',
                        feedback: comment.message || '[No message]',
                        status: 'pending',
                        source: 'facebook',
                        externalId: comment.id,
                        profileUrl: comment.from?.id ? `https://facebook.com/${comment.from.id}` : null,
                    });
                    inserted++;
                } catch (err) {
                    logger.error({ err }, '[v0] Error processing comment');
                }
            }
        }

        logger.info({ inserted, skipped }, '[v0] Total sync complete');
        return { inserted, skipped };

    } catch (error: unknown) {
        const err = error as { response?: { data?: { error?: { message?: string } } }; message?: string };
        const errMsg = err.response?.data?.error?.message || err.message || 'Unknown error';
        throw new Error(`Facebook sync failed: ${errMsg}`);
    }
};