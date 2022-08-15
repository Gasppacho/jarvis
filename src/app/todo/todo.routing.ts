import { Routes, RouterModule } from '@angular/router';
import { TodoComponent } from './todo.component';

const routes: Routes = [
	{
		path: '',
		component: TodoComponent
	},
];

export const TodoRoutes = RouterModule.forChild(routes);
