export type PluginCatalogEntry = {
  id: string
  displayName: string
  description: string
  category: 'ticket'
}

export type PluginSettingField = {
  key: string
  label: string
  type: 'text' | 'password' | 'url'
  placeholder?: string
  description?: string
  encrypted?: boolean
}

export type TicketProviderMeta = {
  id: string
  displayName: string
  urlPattern: string
  settingFields: PluginSettingField[]
  configured: boolean
}

export type TicketFetchResult = {
  providerId: string
  id: string
  title: string
  taskType: 'feat' | 'bugfix' | 'review' | null
  url: string
  /** gitリモートから解決できたリポジトリID（解決できなければ undefined） */
  repoId?: string
  meta?: Record<string, string>
}
