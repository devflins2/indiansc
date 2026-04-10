const mongoose = require('mongoose');
const config = require('./config');
const logger = require('./logger');

// ============ SCHEMAS ============

const videoSchema = new mongoose.Schema({
  url: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  title: {
    type: String,
    required: true
  },
  fileId: {
    type: String,
    required: true
  },
  sizeMb: {
    type: Number,
    required: true
  },
  thumbnail: String,
  duration: Number,
  views: {
    type: Number,
    default: 0
  },
  channelPosted: {
    type: Boolean,
    default: true
  },
  addedAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

const userSchema = new mongoose.Schema({
  userId: {
    type: Number,
    required: true,
    unique: true,
    index: true
  },
  username: String,
  firstName: String,
  totalVideosWatched: {
    type: Number,
    default: 0
  },
  seenVideos: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Video'
  }],
  joinedAt: {
    type: Date,
    default: Date.now
  },
  lastActive: {
    type: Date,
    default: Date.now
  }
});

// Ek user ke dekhe huye videos ki limit badha kar 50000 kar di gayi hai (Taaki life mein dubara repeat na ho)
userSchema.pre('save', function (next) {
  if (this.seenVideos && this.seenVideos.length > 50000) {
    this.seenVideos = this.seenVideos.slice(-50000);
  }
  next();
});

const scrapeQueueSchema = new mongoose.Schema({
  url: {
    type: String,
    required: true,
    unique: true
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'done', 'failed'],
    default: 'pending',
    index: true
  },
  retries: {
    type: Number,
    default: 0
  },
  addedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  error: String
});

// ============ MODELS ============

const Video = mongoose.model('Video', videoSchema);
const User = mongoose.model('User', userSchema);
const ScrapeQueue = mongoose.model('ScrapeQueue', scrapeQueueSchema);

// ============ DATABASE CONNECTION ============

const connectDB = async () => {
  try {
    mongoose.set('strictQuery', false);

    await mongoose.connect(config.MONGO_URI, {
      maxPoolSize: 10,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    logger.log('✅ MongoDB connected successfully');

    // Reset stuck processing items on startup
    const resetResult = await ScrapeQueue.updateMany({ status: 'processing' }, { $set: { status: 'pending' } });
    if (resetResult.modifiedCount > 0) logger.log(`🔄 Reset ${resetResult.modifiedCount} stuck queue items to pending`);

  } catch (error) {
    logger.error('MongoDB connection error', error);
    // Removed process.exit(1) to prevent bot from crashing on DB connection failure
  }
};

// ============ VIDEO FUNCTIONS ============

const addVideo = async (videoData) => {
  try {
    const video = new Video(videoData);
    await video.save();
    logger.log(`✅ New video: ${videoData.title.substring(0, 50)}`);
    return video;
  } catch (error) {
    if (error.code === 11000) {
      // Duplicate - already exists
      return null;
    }
    logger.error('Add video error', error);
    return null;
  }
};

const videoExists = async (url) => {
  const count = await Video.countDocuments({ url });
  return count > 0;
};

const getNextUnseenVideo = async (userId) => {
  try {
    const user = await User.findOne({ userId }).select('seenVideos').lean();
    const seenIds = user?.seenVideos || [];

    // Use aggregation to pick a random unseen video
    const sample = await Video.aggregate([
      { $match: { _id: { $nin: seenIds } } },
      { $sample: { size: 1 } }
    ]);

    return sample[0] || null;
  } catch (error) {
    logger.error('Get video error', error);
    return null;
  }
};

const markVideoSeen = async (userId, videoId) => {
  try {
    await User.updateOne(
      { userId },
      {
        $push: {
          seenVideos: {
            $each: [videoId],
            $slice: -50000
          }
        },
        $inc: { totalVideosWatched: 1 },
        $set: { lastActive: new Date() }
      },
      { upsert: true }
    );

    await Video.updateOne(
      { _id: videoId },
      { $inc: { views: 1 } }
    );
  } catch (error) {
    logger.error('Mark seen error', error);
  }
};

const videoTitleExists = async (title) => {
  const count = await Video.countDocuments({
    title: { $regex: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
  });
  return count > 0;
};

const getTotalVideos = async () => {
  return await Video.estimatedDocumentCount();
};

// ============ USER FUNCTIONS ============

const addUser = async (userId, username, firstName) => {
  try {
    await User.updateOne(
      { userId },
      {
        $set: {
          username,
          firstName,
          lastActive: new Date()
        },
        $setOnInsert: {
          joinedAt: new Date(),
          totalVideosWatched: 0,
          seenVideos: []
        }
      },
      { upsert: true }
    );
  } catch (error) {
    logger.error('Add user error', error);
  }
};

const getUserStats = async (userId) => {
  return await User.findOne({ userId }).lean();
};

const getTotalUsers = async () => {
  return await User.estimatedDocumentCount();
};

// ============ SCRAPE QUEUE FUNCTIONS ============

const addToScrapeQueue = async (urls) => {
  if (!urls || urls.length === 0) return;

  const docs = urls.map(url => ({
    url,
    status: 'pending',
    addedAt: new Date()
  }));

  try {
    // Insert in chunks of 500 to prevent RAM spikes on Render
    const chunkSize = 500;
    for (let i = 0; i < docs.length; i += chunkSize) {
      const chunk = docs.slice(i, i + chunkSize);
      await ScrapeQueue.insertMany(chunk, { ordered: false }).catch(err => {
        // Ignore duplicate key errors for individual chunks
        if (err.code !== 11000) {
          logger.error('Queue chunk insert error', err);
        }
      });
    }
  } catch (error) {
    logger.error('Queue master insert error', error);
  }
};

const getPendingBatch = async (limit = 5) => {
  try {
    const items = await ScrapeQueue.find({
      status: 'pending',
      retries: { $lt: 3 }
    })
      .sort({ addedAt: 1 })
      .limit(limit);

    if (items.length > 0) {
      const ids = items.map(item => item._id);
      await ScrapeQueue.updateMany(
        { _id: { $in: ids } },
        { $set: { status: 'processing' } }
      );
    }

    return items;
  } catch (error) {
    logger.error('Get batch error', error);
    return [];
  }
};

const markScrapeDone = async (queueId) => {
  try {
    await ScrapeQueue.deleteOne({ _id: queueId });
  } catch (error) {
    logger.error('Mark done error', error);
  }
};

const markScrapeFailed = async (queueId, errorMsg) => {
  try {
    await ScrapeQueue.updateOne(
      { _id: queueId },
      {
        $set: {
          status: 'pending',
          error: errorMsg
        },
        $inc: { retries: 1 }
      }
    );
  } catch (error) {
    logger.error('Mark failed error', error);
  }
};

const cleanupOldQueue = async () => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await ScrapeQueue.deleteMany({
      addedAt: { $lt: cutoff },
      retries: { $gte: 3 }
    });

    if (result.deletedCount > 0) {
      logger.log(`🧹 Cleaned ${result.deletedCount} old queue items`);
    }
  } catch (error) {
    logger.error('Cleanup error', error);
  }
};

// ============ STATS ============

const getGlobalStats = async () => {
  try {
    const totalVideos = await getTotalVideos();
    const totalUsers = await getTotalUsers();

    const viewsResult = await Video.aggregate([
      { $group: { _id: null, totalViews: { $sum: '$views' } } }
    ]);

    const totalViews = viewsResult[0]?.totalViews || 0;

    return {
      totalVideos,
      totalUsers,
      totalViews
    };
  } catch (error) {
    logger.error('Stats error', error);
    return {
      totalVideos: 0,
      totalUsers: 0,
      totalViews: 0
    };
  }
};

module.exports = {
  connectDB,
  addVideo,
  videoExists,
  getNextUnseenVideo,
  markVideoSeen,
  getTotalVideos,
  videoTitleExists,
  addUser,
  getUserStats,
  getTotalUsers,
  addToScrapeQueue,
  getPendingBatch,
  markScrapeDone,
  markScrapeFailed,
  cleanupOldQueue,
  getGlobalStats
};
