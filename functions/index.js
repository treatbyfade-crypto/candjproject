const admin = require('firebase-admin');
const functions = require('firebase-functions');
const { defineSecret } = require('firebase-functions/params');
const { createClient } = require('@supabase/supabase-js');

admin.initializeApp();

const ADMIN_EMAIL = 'admin@cj.com';
const SUPABASE_URL = 'https://lcleywliqmyveoqnllgu.supabase.co';
const SUPABASE_BUCKET = 'cj-uploads';
const supabaseServiceRoleKey = defineSecret('SUPABASE_SERVICE_ROLE_KEY');
const COLLECTIONS = [
  'users',
  'transactions',
  'withdrawals',
  'membershipRequests',
  'verifications',
  'notifications',
  'announcements',
  'posts',
  'comments',
  'conversations',
  'messages',
  'supportMessages',
  'marketListings',
  'usernames',
  'settings'
];

async function listStorageFiles(storage, folder = '') {
  const filePaths = [];
  const pageSize = 100;
  let offset = 0;

  while (true) {
    const { data, error } = await storage.from(SUPABASE_BUCKET).list(folder, {
      limit: pageSize,
      offset,
      sortBy: { column: 'name', order: 'asc' }
    });
    if (error) throw error;
    if (!data.length) break;

    for (const entry of data) {
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.id === null) {
        filePaths.push(...await listStorageFiles(storage, path));
      } else {
        filePaths.push(path);
      }
    }

    offset += data.length;
    if (data.length < pageSize) break;
  }

  return filePaths;
}

exports.clearAllApplicationData = functions.runWith({
  timeoutSeconds: 540,
  memory: '1GB',
  secrets: [supabaseServiceRoleKey]
}).https.onCall(async (data, context) => {
  const caller = context.auth;
  const callerEmail = String(caller?.token?.email || '').trim().toLowerCase();
  if (!caller || callerEmail !== ADMIN_EMAIL) {
    throw new functions.https.HttpsError('permission-denied', 'Only the administrator can clear application data.');
  }

  const supabase = createClient(SUPABASE_URL, supabaseServiceRoleKey.value());
  const storageFiles = await listStorageFiles(supabase.storage, '');
  for (let offset = 0; offset < storageFiles.length; offset += 100) {
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove(storageFiles.slice(offset, offset + 100));
    if (error) throw new functions.https.HttpsError('internal', `Could not delete uploaded files: ${error.message}`);
  }

  const auth = admin.auth();
  const userIdsToDelete = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    userIdsToDelete.push(...page.users.filter(user => user.uid !== caller.uid).map(user => user.uid));
    pageToken = page.pageToken;
  } while (pageToken);

  for (let offset = 0; offset < userIdsToDelete.length; offset += 1000) {
    const batch = userIdsToDelete.slice(offset, offset + 1000);
    const result = await auth.deleteUsers(batch);
    if (result.failureCount) {
      throw new functions.https.HttpsError('internal', `Firebase could not delete ${result.failureCount} member authentication account(s).`);
    }
  }

  const firestore = admin.firestore();
  for (const collectionName of COLLECTIONS) {
    const collection = firestore.collection(collectionName);
    if (collectionName === 'users') {
      const users = await collection.get();
      for (const userDoc of users.docs) {
        if (userDoc.id !== caller.uid) await firestore.recursiveDelete(userDoc.ref);
      }
    } else {
      await firestore.recursiveDelete(collection);
    }
  }

  return {
    authAccountsDeleted: userIdsToDelete.length,
    storageFilesDeleted: storageFiles.length
  };
});
