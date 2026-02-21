import { apiGet, apiPost, apiDelete } from './client';

export interface Favorites {
  categories: string[];
  projects: string[];
}

export async function fetchFavorites(): Promise<Favorites> {
  return apiGet<Favorites>('/api/favorites');
}

export async function addFavoriteCategory(name: string): Promise<void> {
  await apiPost(`/api/favorites/categories/${encodeURIComponent(name)}`);
}

export async function removeFavoriteCategory(name: string): Promise<void> {
  await apiDelete(`/api/favorites/categories/${encodeURIComponent(name)}`);
}

export async function addFavoriteProject(name: string): Promise<void> {
  await apiPost(`/api/favorites/projects/${encodeURIComponent(name)}`);
}

export async function removeFavoriteProject(name: string): Promise<void> {
  await apiDelete(`/api/favorites/projects/${encodeURIComponent(name)}`);
}
