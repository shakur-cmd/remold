const a = await ctx.db.get('kn79d8ypbgs5wh7wh6kcny1nbx8f1ttj');
const b = await ctx.db.get('kn7f4521dttjyqkrfvbf56nvws8f06xk');
if (!a || !b || b.name !== 'Synthetic Workspace B') throw new Error('Wrong fixture');
const userId = a.createdBy;
const memberships = await ctx.db.query('members').withIndex('by_user', q => q.eq('userId', userId)).collect();
const bMembers = await ctx.db.query('members').withIndex('by_org_user', q => q.eq('orgId', b._id)).collect();
const invites = await ctx.db.query('invites').collect();
return {a:{_id:a._id,createdBy:a.createdBy},b,bMembers,memberships,invites:invites.map(i=>({_id:i._id,orgId:i.orgId,role:i.role,createdBy:i.createdBy,acceptedBy:i.acceptedBy,acceptedAt:i.acceptedAt,expiresAt:i.expiresAt})),tables:{orgCount:(await ctx.db.query('orgs').collect()).length,userCount:(await ctx.db.query('users').collect()).length,memberCount:(await ctx.db.query('members').collect()).length}};
