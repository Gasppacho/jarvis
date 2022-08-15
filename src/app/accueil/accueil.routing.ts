import { Routes, RouterModule } from '@angular/router';
import { AccueilComponent } from './accueil.component';

const routes: Routes = [
	{
		path: '',
		component: AccueilComponent
	},
];

export const AccueilRoutes = RouterModule.forChild(routes);
