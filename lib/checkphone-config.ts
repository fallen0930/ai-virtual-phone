export type CheckPhoneAppId =
  | "phone"
  | "messages"
  | "browser"
  | "photos"
  | "chat"
  | "shopping"
  | "assets"
  | "notes"
  | "reading"
  | "xiaohongshu"
  | "takeout"
  | "weibo"
  | "douyin"
  | "email"
  | "music"
  | "x"
  | "reddit"
  | "youtube"
  | "bilibili"
  | "instagram"
  | "telegram"
  | "steam"
  | "douban";

export type CheckPhoneManifest = {
  characterId: string;
  dockAppIds: CheckPhoneAppId[];
  fixedAppIds: CheckPhoneAppId[];
  optionalAppIds: CheckPhoneAppId[];
  topAppIds: CheckPhoneAppId[];
  allAppIds: CheckPhoneAppId[];
  generatedAt: string;
  updatedAt: string;
};

export type CheckPhoneSnapshot<AppPayload = unknown> = {
  id: string;
  characterId: string;
  appId: CheckPhoneAppId;
  generatedAt: string;
  updatedAt: string;
  summary?: string;
  payload: AppPayload;
};

export type CheckPhoneNoteCard = {
  id: string;
  title: string;
  preview: string;
  body: string;
  imageDescription?: string;
  tagLabel?: string;
  updatedLabel: string;
  pinned?: boolean;
  tone?: "ivory" | "mist" | "stone";
};

export type CheckPhoneNotesPayload = {
  headerTitle: string;
  headerSubtitle: string;
  notes: CheckPhoneNoteCard[];
};

export type CheckPhoneMessageBubble = {
  id: string;
  text: string;
  timeLabel: string;
  direction: "incoming" | "outgoing";
};

export type CheckPhoneMessageThread = {
  id: string;
  sender: string;
  preview: string;
  timeLabel: string;
  unread?: boolean;
  muted?: boolean;
  kind: string;
  messages: CheckPhoneMessageBubble[];
};

export type CheckPhoneMessagesPayload = {
  headerTitle: string;
  headerSubtitle: string;
  featuredThreadId?: string;
  threads: CheckPhoneMessageThread[];
};

export type CheckPhoneBrowserHistoryItem = {
  id: string;
  title: string;
  urlLabel: string;
  createdAt: string;
  content: string;
  context: string;
  innerThought: string;
};

export type CheckPhoneBrowserBookmark = {
  id: string;
  title: string;
  urlLabel: string;
  categoryLabel: string;
  content: string;
  reason: string;
};

export type CheckPhoneBrowserPayload = {
  headerTitle: string;
  headerSubtitle: string;
  history: CheckPhoneBrowserHistoryItem[];
  bookmarks: CheckPhoneBrowserBookmark[];
};

export type CheckPhonePhotoTone = "silver" | "graphite" | "mist" | "shadow";

export type CheckPhonePhotoAlbum = {
  id: string;
  title: string;
  coverPhotoId: string;
  count: number;
  updatedLabel: string;
  moodLabel: string;
};

export type CheckPhonePhotoItem = {
  id: string;
  albumId: string;
  title: string;
  shotAtLabel: string;
  locationLabel: string;
  description: string;
  tone: CheckPhonePhotoTone;
  previewIcon: string;
};

export type CheckPhonePhotosPayload = {
  headerTitle: string;
  headerSubtitle: string;
  featuredPhotoId?: string;
  albums: CheckPhonePhotoAlbum[];
  photos: CheckPhonePhotoItem[];
};

export type CheckPhoneChatBubble = {
  id: string;
  text: string;
  timeLabel: string;
  direction: "incoming" | "outgoing";
  authorLabel?: string;
};

export type CheckPhoneChatConversation = {
  id: string;
  name: string;
  preview: string;
  timeLabel: string;
  muted?: boolean;
  pinned?: boolean;
  tagLabel: string;
  messages: CheckPhoneChatBubble[];
};

export type CheckPhoneChatGroup = {
  id: string;
  name: string;
  preview: string;
  timeLabel: string;
  muted?: boolean;
  memberCountLabel: string;
  activityLabel: string;
  messages: CheckPhoneChatBubble[];
};

export type CheckPhoneChatMomentComment = {
  id: string;
  authorLabel: string;
  timeLabel: string;
  text: string;
  replyToLabel?: string;
};

export type CheckPhoneChatMomentItem = {
  id: string;
  authorLabel: string;
  authorAccent: string;
  timeLabel: string;
  body: string;
  mediaLabel: string;
  photoUrl?: string;
  photoDescription?: string;
  likeCountLabel: string;
  commentCountLabel: string;
  comments: CheckPhoneChatMomentComment[];
};

export type CheckPhoneChatContact = {
  id: string;
  name: string;
  tagLabel: string;
  relationLabel: string;
  recentLabel: string;
  note: string;
};

export type CheckPhoneChatPayload = {
  headerTitle: string;
  headerSubtitle: string;
  conversations: CheckPhoneChatConversation[];
  groups: CheckPhoneChatGroup[];
  momentsFeed: CheckPhoneChatMomentItem[];
  contacts: CheckPhoneChatContact[];
};

export type CheckPhoneAssetAccountKind = "cash" | "savings" | "investment" | "credit";
export type CheckPhoneAssetCardStyle = "obsidian" | "graphite" | "silver";
export type CheckPhoneAssetAccentLabel = "常用" | "备用" | "储备" | "增值" | "信用";

export type CheckPhoneAssetHeadline = {
  totalLabel: string;
  periodLabel: string;
};

export type CheckPhoneAssetAccount = {
  id: string;
  title: string;
  kind: CheckPhoneAssetAccountKind;
  bankLabel: string;
  maskedNumber: string;
  cardStyle: CheckPhoneAssetCardStyle;
  balance: string;
  note: string;
  accentLabel: CheckPhoneAssetAccentLabel;
};

export type CheckPhoneAssetActivity = {
  id: string;
  title: string;
  amount: string;
  category: string;
  createdAt: string;
  accountId: string;
  detail: string;
};

export type CheckPhoneAssetsPayload = {
  headerTitle: string;
  headerSubtitle: string;
  headline: CheckPhoneAssetHeadline;
  accounts: CheckPhoneAssetAccount[];
  activities: CheckPhoneAssetActivity[];
};

export type CheckPhoneShoppingTone = "ivory" | "mist" | "blush" | "graphite";

export type CheckPhoneShoppingStats = {
  pendingCount: number;
  cartCount: number;
  savedCount: number;
};

export type CheckPhoneShoppingProduct = {
  id: string;
  title: string;
  merchantLabel: string;
  priceLabel: string;
  tagLabel: string;
  subtitle: string;
  detail: string;
  previewIcon: string;
  tone: CheckPhoneShoppingTone;
};

export type CheckPhoneShoppingCartItem = CheckPhoneShoppingProduct & {
  quantityLabel: string;
};

export type CheckPhoneShoppingOrderItem = {
  id: string;
  title: string;
  merchantLabel: string;
  priceLabel: string;
  quantityLabel: string;
  subtitle: string;
  detail: string;
  previewIcon: string;
  tone: CheckPhoneShoppingTone;
};

export type CheckPhoneShoppingShippingStage = "ordered" | "shipped" | "delivering" | "delivered";

export type CheckPhoneShoppingShippingEvent = {
  status: CheckPhoneShoppingShippingStage;
  label: string;
  timeLabel: string;
  timestamp: string;
};

export type CheckPhoneShoppingOrder = {
  id: string;
  statusLabel: string;
  timeLabel: string;
  totalLabel: string;
  merchantLabel: string;
  summary: string;
  note: string;
  items: CheckPhoneShoppingOrderItem[];
  shippingTimeline?: CheckPhoneShoppingShippingEvent[];
  paymentCardId?: string;
  paymentCardLabel?: string;
  paymentTransactionId?: string;
  paidAt?: string;
  paymentStatus?: "paid_by_user" | "payment_requested" | "paid_by_character" | "payment_declined" | "payment_canceled";
  paymentRequestId?: string;
  payerCharacterId?: string;
  payerCharacterName?: string;
  paymentRequestedAt?: string;
  paymentDeclinedAt?: string;
  characterPaidAt?: string;
};

export type CheckPhoneShoppingPayload = {
  headerTitle: string;
  headerSubtitle: string;
  searchHint: string;
  stats: CheckPhoneShoppingStats;
  recentlyViewed: CheckPhoneShoppingProduct[];
  recommendations: CheckPhoneShoppingProduct[];
  savedItems: CheckPhoneShoppingProduct[];
  cartItems: CheckPhoneShoppingCartItem[];
  orders: CheckPhoneShoppingOrder[];
};

export type CheckPhoneEmailItem = {
  id: string;
  senderName: string;
  senderAddress: string;
  subject: string;
  preview: string;
  timeLabel: string;
  body: string;
  recipientLabel: string;
  unread?: boolean;
  starred?: boolean;
  attachmentLabel?: string;
};

export type CheckPhoneEmailPayload = {
  headerTitle: string;
  headerSubtitle: string;
  emails: CheckPhoneEmailItem[];
};

export type CheckPhoneTakeoutCategory =
  | "美食"
  | "饮品"
  | "商超"
  | "药品"
  | "其他";

export type CheckPhoneTakeoutOrder = {
  id: string;
  shopName: string;
  category: CheckPhoneTakeoutCategory;
  createdAt: string;
  icon: string;
  status: string;
  amount: number;
  items: CheckPhoneTakeoutItem[];
  note?: string;
  scenario: string;
  innerVoice: string;
  review?: string;
};

export type CheckPhoneTakeoutItem = {
  name: string;
  icon: string;
};

export type CheckPhoneTakeoutPayload = {
  headerTitle: string;
  headerSubtitle: string;
  orders: CheckPhoneTakeoutOrder[];
};

export type CheckPhoneSteamProfile = {
  name: string;
  handle: string;
  bio: string;
};

export type CheckPhoneSteamRecentGame = {
  id: string;
  title: string;
  icon: string;
  genre: string;
  totalHours: number;
  recentHours: number;
  progressPercent: number;
  lastPlayedAt: string;
  status: string;
  note: string;
};

export type CheckPhoneSteamWishlistGame = {
  id: string;
  title: string;
  icon: string;
  genre: string;
  price: number;
  reason: string;
};

export type CheckPhoneSteamLibraryGame = {
  id: string;
  title: string;
  icon: string;
  genre: string;
  totalHours: number;
  progressPercent: number;
  lastPlayedAt: string;
  status: string;
  note: string;
};

export type CheckPhoneSteamPayload = {
  headerTitle: string;
  profile: CheckPhoneSteamProfile;
  recentlyPlayed: CheckPhoneSteamRecentGame[];
  wishlist: CheckPhoneSteamWishlistGame[];
  library: CheckPhoneSteamLibraryGame[];
};

export type CheckPhoneBilibiliHistoryVideo = {
  id: string;
  title: string;
  upName: string;
  icon: string;
  visualDescription: string;
  createdAt: string;
  durationLabel: string;
  playCount: number;
  progressLabel: string;
  stateNote: string;
  feeling: string;
};

export type CheckPhoneBilibiliFavoriteVideo = {
  id: string;
  title: string;
  upName: string;
  icon: string;
  visualDescription: string;
  createdAt: string;
  durationLabel: string;
  playCount: number;
  saveReason: string;
  feeling: string;
};

export type CheckPhoneBilibiliPayload = {
  headerTitle: string;
  headerSubtitle: string;
  watchHistory: CheckPhoneBilibiliHistoryVideo[];
  favorites: CheckPhoneBilibiliFavoriteVideo[];
};

export type CheckPhoneYoutubeProfile = {
  name: string;
  handle: string;
  bio: string;
  lastActiveAt: string;
};

export type CheckPhoneYoutubeHistoryVideo = {
  id: string;
  title: string;
  channelName: string;
  icon?: string;
  createdAt: string;
  durationLabel: string;
  playCount: number;
  progressLabel: string;
  stateNote: string;
  feeling: string;
};

export type CheckPhoneYoutubeWatchLaterVideo = {
  id: string;
  title: string;
  channelName: string;
  icon?: string;
  createdAt: string;
  durationLabel: string;
  playCount: number;
  stateNote: string;
  feeling: string;
};

export type CheckPhoneYoutubeLikedVideo = {
  id: string;
  title: string;
  channelName: string;
  icon?: string;
  createdAt: string;
  durationLabel: string;
  playCount: number;
  stateNote: string;
  feeling: string;
};

export type CheckPhoneYoutubePayload = {
  headerTitle: string;
  headerSubtitle: string;
  profile?: CheckPhoneYoutubeProfile;
  watchHistory: CheckPhoneYoutubeHistoryVideo[];
  watchLater: CheckPhoneYoutubeWatchLaterVideo[];
  likedVideos: CheckPhoneYoutubeLikedVideo[];
};

export type CheckPhoneRedditProfile = {
  name: string;
  handle: string;
  bio: string;
  followers: number;
  postKarma: number;
  commentKarma: number;
  cakeDay: string;
};

export type CheckPhoneRedditPost = {
  id: string;
  communityName: string;
  title: string;
  body: string;
  createdAt: string;
  upvoteCount: number;
  commentCount: number;
  viewCount: number;
  innerThought: string;
};

export type CheckPhoneRedditComment = {
  id: string;
  communityName: string;
  postTitle: string;
  body: string;
  createdAt: string;
  upvoteCount: number;
  viewCount: number;
  innerThought: string;
};

export type CheckPhoneRedditPayload = {
  headerTitle: string;
  headerSubtitle: string;
  profile: CheckPhoneRedditProfile;
  posts: CheckPhoneRedditPost[];
  comments: CheckPhoneRedditComment[];
};

export type CheckPhoneTelegramThreadKind = "saved" | "direct" | "group" | "channel";
export type CheckPhoneTelegramMessageType = "text" | "voice" | "thinking";

export type CheckPhoneTelegramMessage = {
  id: string;
  authorName: string;
  text: string;
  createdAt: string;
  direction: "incoming" | "outgoing";
  messageType?: CheckPhoneTelegramMessageType;
  replyTitle?: string;
  replyText?: string;
  voiceDuration?: string;
  voiceTranscript?: string;
};

export type CheckPhoneTelegramThread = {
  id: string;
  title: string;
  kind: CheckPhoneTelegramThreadKind;
  handle?: string;
  about?: string;
  avatarLabel?: string;
  verified?: boolean;
  online?: boolean;
  isBot?: boolean;
  lastStatus?: "none" | "sent" | "read";
  unreadCount: number;
  pinned?: boolean;
  muted?: boolean;
  messages: CheckPhoneTelegramMessage[];
};

export type CheckPhoneTelegramPayload = {
  headerTitle: string;
  headerSubtitle: string;
  threads: CheckPhoneTelegramThread[];
};

export type CheckPhoneDouyinTone = "ivory" | "mist" | "blush" | "graphite";

export type CheckPhoneDouyinComment = {
  id: string;
  authorName: string;
  text: string;
  createdAt: string;
  replyTo?: string;
  replyToCommentId?: string;
};

export type CheckPhoneDouyinVideo = {
  id: string;
  authorName?: string;
  title: string;
  caption: string;
  videoDescription?: string;
  coverIcon?: string;
  tone: CheckPhoneDouyinTone;
  createdAt: string;
  playCount?: number;
  likeCount?: number;
  commentCount?: number;
  saveCount?: number;
  comments: CheckPhoneDouyinComment[];
};

export type CheckPhoneDouyinProfile = {
  name: string;
  handle: string;
  bio: string;
  likesTotal?: number;
  mutualFollowCount?: number;
  followingCount?: number;
  followerCount?: number;
};

export type CheckPhoneDouyinPayload = {
  headerTitle: string;
  headerSubtitle: string;
  profile: CheckPhoneDouyinProfile;
  works: CheckPhoneDouyinVideo[];
  savedVideos: CheckPhoneDouyinVideo[];
  likedVideos: CheckPhoneDouyinVideo[];
};

export type CheckPhoneInstagramComment = {
  id: string;
  authorName: string;
  text: string;
  createdAt: string;
  likeCount?: number;
};

export type CheckPhoneInstagramPost = {
  id: string;
  coverIcon: string;
  imageDescription?: string;
  createdAt: string;
  location?: string;
  caption: string;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  comments: CheckPhoneInstagramComment[];
};

export type CheckPhoneInstagramHighlight = {
  id: string;
  title: string;
  coverIcon: string;
  description: string;
};

export type CheckPhoneInstagramProfile = {
  name: string;
  username: string;
  bio: string;
  followingCount: number;
  followerCount: number;
};

export type CheckPhoneInstagramPayload = {
  headerTitle: string;
  headerSubtitle: string;
  profile: CheckPhoneInstagramProfile;
  highlights: CheckPhoneInstagramHighlight[];
  posts: CheckPhoneInstagramPost[];
};

export type CheckPhoneXProfile = {
  name: string;
  handle: string;
  bio: string;
  location?: string;
  joinedAt?: string;
  followingCount: number;
  followerCount: number;
};

export type CheckPhoneXPost = {
  id: string;
  body: string;
  mediaDescription?: string;
  createdAt: string;
  replyCount: number;
  repostCount: number;
  likeCount: number;
  viewCount: number;
  note: string;
};

export type CheckPhoneXReply = {
  id: string;
  targetName: string;
  targetSnippet: string;
  body: string;
  createdAt: string;
  replyCount: number;
  repostCount: number;
  likeCount: number;
  viewCount: number;
  note: string;
};

export type CheckPhoneXMedia = {
  id: string;
  body: string;
  mediaDescription: string;
  createdAt: string;
  replyCount: number;
  repostCount: number;
  likeCount: number;
  viewCount: number;
  note: string;
};

export type CheckPhoneXLike = {
  id: string;
  authorName: string;
  authorHandle: string;
  body: string;
  mediaDescription?: string;
  createdAt: string;
  replyCount: number;
  repostCount: number;
  likeCount: number;
  viewCount: number;
  likeReason: string;
};

export type CheckPhoneXPayload = {
  headerTitle: string;
  headerSubtitle: string;
  profile: CheckPhoneXProfile;
  posts: CheckPhoneXPost[];
  replies: CheckPhoneXReply[];
  media: CheckPhoneXMedia[];
  likes: CheckPhoneXLike[];
};

export type CheckPhoneDoubanTone = "linen" | "mist" | "graphite" | "blush";
export type CheckPhoneDoubanActivityType = "post" | "movie_review" | "book_review" | "diary" | "listened" | "want_watch" | "want_read";

export type CheckPhoneDoubanComment = {
  id: string;
  authorName: string;
  text: string;
  createdAt: string;
  replyTo?: string;
};

export type CheckPhoneDoubanGroupItem = {
  id: string;
  name: string;
  coverIcon: string;
  tone: CheckPhoneDoubanTone;
  memberCount: number;
  latestUpdate: string;
  updatedAt: string;
};

export type CheckPhoneDoubanTopicItem = {
  id: string;
  groupName: string;
  title: string;
  authorName: string;
  body: string;
  createdAt: string;
  likeCount: number;
  saveCount: number;
  repostCount: number;
  comments: CheckPhoneDoubanComment[];
};

export type CheckPhoneDoubanProfile = {
  name: string;
  bio: string;
  location?: string;
  joinedAt?: string;
  followingCount: number;
  followerCount: number;
  wantWatchCount: number;
  wantReadCount: number;
};

export type CheckPhoneDoubanActivityItem = {
  id: string;
  type: CheckPhoneDoubanActivityType;
  actionLabel: string;
  categoryLabel?: string;
  title: string;
  body: string;
  createdAt: string;
  subjectName?: string;
  subjectMeta?: string;
  coverIcon?: string;
  rating?: number;
  reactionCount: number;
  commentCount: number;
};

export type CheckPhoneDoubanPayload = {
  headerTitle: string;
  headerSubtitle: string;
  profile: CheckPhoneDoubanProfile;
  activities: CheckPhoneDoubanActivityItem[];
  myGroups?: CheckPhoneDoubanGroupItem[];
  repliedTopics?: CheckPhoneDoubanTopicItem[];
  publishedTopics?: CheckPhoneDoubanTopicItem[];
};

export type CheckPhoneXiaohongshuTone = "ivory" | "mist" | "blush" | "graphite";

export type CheckPhoneXiaohongshuComment = {
  id: string;
  authorName: string;
  text: string;
  replyTo?: string;
  replyToCommentId?: string;
};

export type CheckPhoneXiaohongshuNote = {
  id: string;
  authorName: string;
  title: string;
  body: string;
  videoDescription?: string;
  coverIcon: string;
  tone: CheckPhoneXiaohongshuTone;
  likeCount: number;
  commentCount: number;
  saveCount: number;
  liked?: boolean;
  saved?: boolean;
  tags: string[];
  comments: CheckPhoneXiaohongshuComment[];
};

export type CheckPhoneXiaohongshuMessageOverview = {
  likesAndSavesCount: number;
  newFollowersCount: number;
  commentsAndMentionsCount: number;
};

export type CheckPhoneXiaohongshuThreadMessage = {
  id: string;
  authorName: string;
  text: string;
  timeLabel: string;
  direction: "incoming" | "outgoing";
};

export type CheckPhoneXiaohongshuThreadType = "direct" | "group";

export type CheckPhoneXiaohongshuThread = {
  id: string;
  name: string;
  type: CheckPhoneXiaohongshuThreadType;
  unread?: boolean;
  tagLabel: string;
  messages: CheckPhoneXiaohongshuThreadMessage[];
};

export type CheckPhoneXiaohongshuProfile = {
  name: string;
  handle?: string;
  bio: string;
  followingCount: number;
  followerCount: number;
  likedAndSavedCount: number;
};

export type CheckPhoneXiaohongshuPayload = {
  headerTitle: string;
  headerSubtitle: string;
  profile: CheckPhoneXiaohongshuProfile;
  homeNotes: CheckPhoneXiaohongshuNote[];
  videoNotes: CheckPhoneXiaohongshuNote[];
  myNotes: CheckPhoneXiaohongshuNote[];
  messageOverview: CheckPhoneXiaohongshuMessageOverview;
  messageThreads: CheckPhoneXiaohongshuThread[];
};

export type CheckPhoneWeiboTone = "ivory" | "mist" | "graphite" | "blush";

export type CheckPhoneWeiboComment = {
  id: string;
  authorName: string;
  text: string;
  replyTo?: string;
  replyToCommentId?: string;
};

export type CheckPhoneWeiboPost = {
  id: string;
  authorName: string;
  authorBadge: string;
  body: string;
  mediaIcon: string;
  tone: CheckPhoneWeiboTone;
  repostCount: number;
  commentCount: number;
  likeCount: number;
  comments: CheckPhoneWeiboComment[];
};

export type CheckPhoneWeiboTopic = {
  id: string;
  title: string;
  heatLabel: string;
  summary: string;
  relatedPostIds?: string[];
};

export type CheckPhoneWeiboMessageOverview = {
  mentionsCount: number;
  commentsCount: number;
  likesCount: number;
};

export type CheckPhoneWeiboThreadMessage = {
  id: string;
  authorName: string;
  text: string;
  timeLabel: string;
  direction: "incoming" | "outgoing";
};

export type CheckPhoneWeiboThread = {
  id: string;
  name: string;
  type: "direct" | "group";
  unread?: boolean;
  tagLabel: string;
  messages: CheckPhoneWeiboThreadMessage[];
};

export type CheckPhoneWeiboProfile = {
  name: string;
  handle: string;
  bio: string;
  followingCount: number;
  followerCount: number;
  likedTotal: number;
};

export type CheckPhoneWeiboPayload = {
  headerTitle: string;
  headerSubtitle: string;
  profile: CheckPhoneWeiboProfile;
  homePosts: CheckPhoneWeiboPost[];
  trendingTopics: CheckPhoneWeiboTopic[];
  messageOverview: CheckPhoneWeiboMessageOverview;
  messageThreads: CheckPhoneWeiboThread[];
  myPosts: CheckPhoneWeiboPost[];
};

export type CheckPhoneReadingTone = "linen" | "mist" | "graphite";
export type CheckPhoneReadingBookStatus = "reading" | "finished" | "wishlist" | "paused";

export type CheckPhoneReadingBook = {
  id: string;
  title: string;
  author: string;
  coverIcon: string;
  tone: CheckPhoneReadingTone;
  status: CheckPhoneReadingBookStatus;
  progressLabel: string;
  summary: string;
  tags: string[];
};

export type CheckPhoneReadingHighlight = {
  id: string;
  bookId: string;
  quote: string;
  chapterLabel: string;
  note: string;
};

export type CheckPhoneReadingNote = {
  id: string;
  bookId: string;
  title: string;
  body: string;
  updatedLabel: string;
};

export type CheckPhoneReadingProfile = {
  status: string;
  updatedLabel: string;
  displayName?: string;
  summary?: string;
};

export type CheckPhoneReadingPayload = {
  headerTitle: string;
  headerSubtitle: string;
  profile: CheckPhoneReadingProfile;
  currentBooks: CheckPhoneReadingBook[];
  highlights: CheckPhoneReadingHighlight[];
  libraryBooks: CheckPhoneReadingBook[];
  notes: CheckPhoneReadingNote[];
};

export type CheckPhoneMusicTone = "obsidian" | "graphite" | "silver" | "mist";

export type CheckPhoneMusicTrack = {
  id: string;
  title: string;
  artist: string;
  albumTitle: string;
  coverIcon: string;
  tone: CheckPhoneMusicTone;
  durationLabel: string;
  note: string;
  liked?: boolean;
};

export type CheckPhoneMusicPlaylist = {
  id: string;
  title: string;
  subtitle: string;
  coverIcon: string;
  tone: CheckPhoneMusicTone;
  trackIds: string[];
  saved?: boolean;
  curatorNote: string;
};

export type CheckPhoneMusicProfile = {
  nickname: string;
  listeningMood: string;
  monthlyMinutesLabel: string;
  topArtistLabel: string;
};

export type CheckPhoneMusicPayload = {
  headerTitle: string;
  profile: CheckPhoneMusicProfile;
  nowPlayingTrackId?: string;
  recentTracks: CheckPhoneMusicTrack[];
  likedTracks: CheckPhoneMusicTrack[];
  playlists: CheckPhoneMusicPlaylist[];
};

export type CheckPhoneCallDirection = "incoming" | "outgoing" | "missed";

export type CheckPhoneCallLog = {
  id: string;
  name: string;
  createdAt: string;
  durationLabel: string;
  direction: CheckPhoneCallDirection;
  summary: string;
  innerThought: string;
};

export type CheckPhoneContactCard = {
  id: string;
  name: string;
  tagLabel: string;
  note: string;
  accentLabel: string;
};

export type CheckPhoneVoicemail = {
  id: string;
  name: string;
  createdAt: string;
  durationLabel: string;
  transcript: string;
};

export type CheckPhonePhonePayload = {
  headerTitle: string;
  headerSubtitle: string;
  recents: CheckPhoneCallLog[];
  contacts: CheckPhoneContactCard[];
  voicemails: CheckPhoneVoicemail[];
};

export type CheckPhoneAppSpec = {
  id: CheckPhoneAppId;
  label: string;
  shortLabel?: string;
  englishLabel: string;
};

export type CheckPhonePromptSecondaryTag =
  | "manifest"
  | "phone"
  | "messages"
  | "browser"
  | "photos"
  | "messenger"
  | "shopping"
  | "assets"
  | "notes"
  | "reader"
  | "xiaohongshu"
  | "takeout"
  | "weibo"
  | "douyin"
  | "email"
  | "music"
  | "x"
  | "reddit"
  | "youtube"
  | "bilibili"
  | "instagram"
  | "telegram"
  | "steam"
  | "douban";

export type CheckPhoneTagProfile = {
  id: string;
  label: string;
  tags: string[];
};

export const CHECKPHONE_DOCK_APP_IDS: CheckPhoneAppId[] = [
  "phone",
  "messages",
  "browser",
  "photos",
];

export const CHECKPHONE_FIXED_APP_IDS: CheckPhoneAppId[] = [
  "chat",
  "shopping",
  "assets",
  "notes",
];

export const CHECKPHONE_OPTIONAL_POOL_APP_IDS: CheckPhoneAppId[] = [
  "reading",
  "xiaohongshu",
  "takeout",
  "weibo",
  "douyin",
  "email",
  "music",
  "x",
  "reddit",
  "youtube",
  "bilibili",
  "instagram",
  "telegram",
  "steam",
  "douban",
];

export const CHECKPHONE_TOP_APP_COUNT = 12;
export const CHECKPHONE_OPTIONAL_SELECTION_COUNT = 8;

export const CHECKPHONE_APP_SPECS: Record<CheckPhoneAppId, CheckPhoneAppSpec> = {
  phone: { id: "phone", label: "电话", englishLabel: "Phone" },
  messages: { id: "messages", label: "信息", englishLabel: "Messages" },
  browser: { id: "browser", label: "浏览器", englishLabel: "Browser" },
  photos: { id: "photos", label: "相册", englishLabel: "Photos" },
  chat: { id: "chat", label: "聊天", englishLabel: "Chat" },
  shopping: { id: "shopping", label: "购物", englishLabel: "Shopping" },
  assets: { id: "assets", label: "资产", englishLabel: "Assets" },
  notes: { id: "notes", label: "备忘录", englishLabel: "Notes" },
  reading: { id: "reading", label: "阅读", englishLabel: "Reading" },
  xiaohongshu: { id: "xiaohongshu", label: "小红书", englishLabel: "Xiaohongshu", shortLabel: "小红书" },
  takeout: { id: "takeout", label: "外卖", englishLabel: "Takeout" },
  weibo: { id: "weibo", label: "微博", englishLabel: "Weibo" },
  douyin: { id: "douyin", label: "抖音", englishLabel: "Douyin" },
  email: { id: "email", label: "邮箱", englishLabel: "Email" },
  music: { id: "music", label: "音乐", englishLabel: "Music" },
  x: { id: "x", label: "X", englishLabel: "X" },
  reddit: { id: "reddit", label: "Reddit", englishLabel: "Reddit" },
  youtube: { id: "youtube", label: "YouTube", englishLabel: "YouTube" },
  bilibili: { id: "bilibili", label: "B站", englishLabel: "Bilibili" },
  instagram: { id: "instagram", label: "Instagram", englishLabel: "Instagram" },
  telegram: { id: "telegram", label: "Telegram", englishLabel: "Telegram" },
  steam: { id: "steam", label: "游戏库", englishLabel: "Game Library" },
  douban: { id: "douban", label: "豆瓣", englishLabel: "Douban" },
};

const CHECKPHONE_PROMPT_APP_ORDER: CheckPhoneAppId[] = [
  ...CHECKPHONE_DOCK_APP_IDS,
  ...CHECKPHONE_FIXED_APP_IDS,
  ...CHECKPHONE_OPTIONAL_POOL_APP_IDS,
];

const CHECKPHONE_APP_PROMPT_TAGS: Record<CheckPhoneAppId, Exclude<CheckPhonePromptSecondaryTag, "manifest">> = {
  phone: "phone",
  messages: "messages",
  browser: "browser",
  photos: "photos",
  chat: "messenger",
  shopping: "shopping",
  assets: "assets",
  notes: "notes",
  reading: "reader",
  xiaohongshu: "xiaohongshu",
  takeout: "takeout",
  weibo: "weibo",
  douyin: "douyin",
  email: "email",
  music: "music",
  x: "x",
  reddit: "reddit",
  youtube: "youtube",
  bilibili: "bilibili",
  instagram: "instagram",
  telegram: "telegram",
  steam: "steam",
  douban: "douban",
};

export const CHECKPHONE_PROMPT_SECONDARY_TAG_LABELS: Record<CheckPhonePromptSecondaryTag, string> = {
  manifest: "清单",
  phone: CHECKPHONE_APP_SPECS.phone.label,
  messages: CHECKPHONE_APP_SPECS.messages.label,
  browser: CHECKPHONE_APP_SPECS.browser.label,
  photos: CHECKPHONE_APP_SPECS.photos.label,
  messenger: CHECKPHONE_APP_SPECS.chat.label,
  shopping: CHECKPHONE_APP_SPECS.shopping.label,
  assets: CHECKPHONE_APP_SPECS.assets.label,
  notes: CHECKPHONE_APP_SPECS.notes.label,
  reader: CHECKPHONE_APP_SPECS.reading.label,
  xiaohongshu: CHECKPHONE_APP_SPECS.xiaohongshu.label,
  takeout: CHECKPHONE_APP_SPECS.takeout.label,
  weibo: CHECKPHONE_APP_SPECS.weibo.label,
  douyin: CHECKPHONE_APP_SPECS.douyin.label,
  email: CHECKPHONE_APP_SPECS.email.label,
  music: CHECKPHONE_APP_SPECS.music.label,
  x: CHECKPHONE_APP_SPECS.x.label,
  reddit: CHECKPHONE_APP_SPECS.reddit.label,
  youtube: CHECKPHONE_APP_SPECS.youtube.label,
  bilibili: CHECKPHONE_APP_SPECS.bilibili.label,
  instagram: CHECKPHONE_APP_SPECS.instagram.label,
  telegram: CHECKPHONE_APP_SPECS.telegram.label,
  steam: CHECKPHONE_APP_SPECS.steam.label,
  douban: CHECKPHONE_APP_SPECS.douban.label,
};

export function getCheckPhonePromptTags(
  target: CheckPhonePromptSecondaryTag | CheckPhoneAppId,
): ["checkphone", CheckPhonePromptSecondaryTag] {
  if (target === "manifest") return ["checkphone", "manifest"];
  const secondary = isCheckPhoneAppId(target) ? CHECKPHONE_APP_PROMPT_TAGS[target] : target;
  return ["checkphone", secondary];
}

export function getCheckPhonePromptSecondaryTagLabel(tag: string): string | null {
  if (tag === "checkphone") return "查手机";
  if (tag === "manifest") return CHECKPHONE_PROMPT_SECONDARY_TAG_LABELS.manifest;
  if (tag in CHECKPHONE_PROMPT_SECONDARY_TAG_LABELS) {
    return CHECKPHONE_PROMPT_SECONDARY_TAG_LABELS[tag as CheckPhonePromptSecondaryTag];
  }
  return isCheckPhoneAppId(tag) ? CHECKPHONE_APP_SPECS[tag].label : null;
}

export const CHECKPHONE_TAG_PROFILES: CheckPhoneTagProfile[] = [
  {
    id: "checkphone",
    label: "查手机",
    tags: ["checkphone"],
  },
  {
    id: "checkphone_manifest",
    label: `查手机 · ${CHECKPHONE_PROMPT_SECONDARY_TAG_LABELS.manifest}`,
    tags: getCheckPhonePromptTags("manifest"),
  },
  ...CHECKPHONE_PROMPT_APP_ORDER.map((appId) => ({
    id: `checkphone_${appId}`,
    label: `查手机 · ${CHECKPHONE_PROMPT_SECONDARY_TAG_LABELS[CHECKPHONE_APP_PROMPT_TAGS[appId]]}`,
    tags: getCheckPhonePromptTags(appId),
  })),
];

export function isCheckPhoneAppId(value: string): value is CheckPhoneAppId {
  return value in CHECKPHONE_APP_SPECS;
}

export function formatCheckPhoneOptionalPoolText(): string {
  return CHECKPHONE_OPTIONAL_POOL_APP_IDS.map((id) => `${id}（${CHECKPHONE_APP_SPECS[id].label}）`).join("、");
}
