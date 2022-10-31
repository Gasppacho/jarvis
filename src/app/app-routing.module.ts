import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

const routes: Routes = [
	{
		path: 'accueil',
		loadChildren: () => import('./accueil/accueil.module').then((m) => m.AccueilModule),
	},
	{
		path: 'todo',
		loadChildren: () => import('./todo/todo.module').then((m) => m.TodoModule),
	},
	{
		path: 'journal',
		loadChildren: () => import('./journal/journal.module').then((m) => m.JournalModule),
	},
	{
		path: '',
		redirectTo: 'accueil',
		pathMatch: 'full',
	},
];

@NgModule({
	imports: [RouterModule.forRoot(routes)],
	exports: [RouterModule],
})
export class AppRoutingModule {}
