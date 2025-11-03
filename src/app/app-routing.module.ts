import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import {TestComponent} from "./components/test/test.component";

const routes: Routes = [
  { path: '', redirectTo:'test' },
  { path: 'test', component: TestComponent },
  { path: 'test-a', loadComponent: () => import('./components/test-a/test-a.component').then(m => m.TestAComponent) },
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
